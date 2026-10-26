// @tokenrouter/dsh-telemetry — DeepSeek Harness plugin that reports every
// session (main agent, sub-agents, forks), model call, tool/MCP call,
// compaction and error to TokenRouter's OTLP receiver as content-free log
// records, so TokenRouter can rebuild the session tree and join each model
// call to its Router request by the upstream response id.
//
// Live capture follows the DSH session bus with its own per-session cursor
// (never the shared SessionTelemetryCoordinator, whose module-global cursor
// would starve DeepSeek's feedback upload). Each canonical event passes the
// deployment's `session-telemetry/record` redaction waterfall before mapping.
//
// The plugin also marks DSH's model requests to TokenRouter with its version
// and the calling session's links (lib/headers.js), with or without a Key, so
// Router records carry them, and gives OpenAI Chat / Responses bodies without
// one a prompt_cache_key equal to that session id. Without TOKENROUTER_API_KEY
// the export uses the Key of those same requests.

import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createSessionMapper, agentErrorRecord, subagentStartRecord, sessionLinks, MAPPED_TYPES, SUBAGENT_TOOL } from './mapper.js';
import { createExporter } from './exporter.js';
import { createRequestHeaders } from './headers.js';

export const name = 'tokenrouter-dsh-telemetry';
export const inject = ['sessions'];
export const DEFAULT_URL = 'https://tokenrouterv2.omgwow.tech/v1/otel';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// DSH runtime version from the launcher's package (…/@deepseek-ai/dsh/lib/bin.js).
function dshVersion() {
  try {
    let dir = dirname(realpathSync(process.argv[1]));
    for (let i = 0; i < 4; i++, dir = dirname(dir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (pkg.name === '@deepseek-ai/dsh') return pkg.version;
      } catch { /* not here */ }
    }
  } catch { /* no launcher path */ }
  return undefined;
}

// The canonical record shape of @deepseek-ai/dsh-session-telemetry, so the
// deployment's redaction rules (`session-telemetry/record`) apply unchanged.
// Events are deep-frozen: a rule that mutates instead of returning a new
// record throws and withholds that record (fail-closed).
function canonicalRecord(session, event) {
  const { data, ...envelope } = event;
  const attributes = { 'session.id': String(session.id), 'session.format_version': session.header?.version, 'event.type': event.type, 'event.seq': event.seq };
  if (session.header?.parentSession !== undefined) attributes['session.parent_id'] = String(session.header.parentSession);
  if (session.header?.isSeeded) attributes['session.seed_length'] = session.inheritedEventCount;
  const severity = (event.type === 'tool/result' && data?.message?.isError === true) || (event.type === 'turn/end' && data?.reason?.kind === 'error') ? 'error' : 'info';
  return { sourceEvent: { sessionId: String(session.id), envelope }, channel: 'ledger', time: event.time, severity, attributes, body: data };
}

function httpUrl(raw, what) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${name}: ${what} is not a valid URL: ${JSON.stringify(raw)}`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${name}: ${what} must be http(s), got ${url.protocol}`);
  return url;
}

export function resolveConfig(config = {}, env = process.env) {
  const apiKey = typeof config.apiKey === 'string' && config.apiKey ? config.apiKey : env.TOKENROUTER_API_KEY || undefined;
  const raw = (typeof config.url === 'string' && config.url ? config.url : env.TOKENROUTER_OTEL_URL || DEFAULT_URL).trim().replace(/\/+$/, '');
  const url = httpUrl(raw, 'url');
  // Accept the base (…/v1/otel) or the full logs endpoint (…/v1/otel/v1/logs).
  const endpoint = /\/v1\/logs$/.test(url.pathname) ? url.href : url.href.replace(/\/+$/, '') + '/v1/logs';
  // Model requests get the headers only on the gateway origin: the receiver's
  // origin unless the DSH route points elsewhere (TOKENROUTER_BASE_URL).
  const base = typeof config.baseUrl === 'string' && config.baseUrl ? config.baseUrl : env.TOKENROUTER_BASE_URL || undefined;
  const gatewayOrigin = base ? httpUrl(base.trim(), 'baseUrl').origin : url.origin;
  return { apiKey, endpoint, gatewayOrigin, exporter: config.exporter && typeof config.exporter === 'object' ? config.exporter : {} };
}

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  // Without TOKENROUTER_API_KEY the export uses the Key DSH itself sends to TokenRouter, captured
  // from its first model request there; only when the receiver is that same origin.
  let routeKey;
  const reuseRouteKey = !resolved.apiKey && new URL(resolved.endpoint).origin === resolved.gatewayOrigin;
  if (!resolved.apiKey && !reuseRouteKey) ctx.logger.warn(`${name}: TOKENROUTER_API_KEY is not set and the model route is not ${new URL(resolved.endpoint).origin}; only request headers are added`);
  const exporter = createExporter({
    ...resolved.exporter,
    endpoint: resolved.endpoint, apiKey: () => resolved.apiKey ?? routeKey, logger: ctx.logger,
    resource: { 'service.name': 'deepseek-harness', 'service.version': dshVersion(), 'telemetry.sdk.name': PACKAGE.name, 'telemetry.sdk.version': PACKAGE.version },
    scope: { name: PACKAGE.name, version: PACKAGE.version },
  });
  const mappers = new Map();   // live Session object → mapper
  // The delegation tool call a parent is running: a child session announced
  // inside it was started by that call.
  const delegation = new AsyncLocalStorage();

  // cordis `emit` stops at the first throwing listener: nothing may escape.
  const contain = step => {
    try { step(); } catch (error) { ctx.logger.warn(`${name}: capture step failed: ${String(error?.message ?? error)}`); }
  };
  const exportOn = Boolean(resolved.apiKey) || reuseRouteKey;
  const emit = records => { if (exportOn && records.length) exporter.enqueue(records); };

  function capture(session, mapper, event) {
    if (!MAPPED_TYPES.has(event.type) || event.seq <= mapper.lastSeq) return;
    contain(() => {
      const record = ctx.waterfall('session-telemetry/record', canonicalRecord(session, event), (r) => r);
      const source = record?.sourceEvent?.envelope;
      if (!source) { mapper.map({ type: null, seq: event.seq }); return; }   // withheld by a rule
      emit(mapper.map({ type: source.type, seq: source.seq, time: source.time, data: record.body }));
    });
  }

  // Own events start after the fork-inherited prefix. A resumed session replays
  // its stored own history once: the records are identical to the ones sent
  // live, so the receiver dedupes them, and the mapper regains open calls.
  function adopt(session) {
    let mapper = mappers.get(session);
    if (mapper) return mapper;
    mapper = createSessionMapper(session);
    mappers.set(session, mapper);
    contain(() => emit([mapper.sessionRecord()]));
    contain(() => { for (const event of session.snapshotEvents(session.inheritedEventCount ?? 0)) capture(session, mapper, event); });
    return mapper;
  }

  ctx.on('tools/execute', (exec, next) => {
    const callId = exec?.callId, parent = exec?.agent?.session?.id;
    if (typeof callId !== 'string' || parent === undefined || !SUBAGENT_TOOL.test(String(exec.name ?? ''))) return next();
    return delegation.run({ callId, toolName: String(exec.name), parent: String(parent) }, next);
  }, { global: true });
  const spawnCalls = new Map();   // live child session id → the parent tool call that started it
  ctx.on('session/created', (session) => contain(() => {
    const call = delegation.getStore();
    const parent = session?.header?.parentSession;
    if (call && parent !== undefined && parent !== null && String(parent) === call.parent && String(session.id) !== call.parent) {
      spawnCalls.set(String(session.id), call.callId);
      emit([subagentStartRecord({ child: session.id, header: session.header, inheritedEventCount: session.inheritedEventCount, callId: call.callId, toolName: call.toolName })]);
    }
    adopt(session);
  }));
  ctx.on('session/event', (session, event) => contain(() => {
    capture(session, adopt(session), event);
    if (event.type === 'turn/end') exporter.flush();
  }));
  ctx.on('session/flush', () => contain(() => exporter.flush()));
  ctx.on('session/disposed', (session) => contain(() => { mappers.delete(session); spawnCalls.delete(String(session?.id)); exporter.flush(); }));
  ctx.on('agent/error', (payload) => contain(() => {
    const sessionId = payload?.agent?.session?.id ?? payload?.agent?.id;
    if (sessionId !== undefined) emit([agentErrorRecord({ sessionId, turn: payload.turn, step: payload.step, error: payload.error })]);
  }));
  for (const session of ctx.sessions.list()) contain(() => adopt(session));

  // Model requests to TokenRouter: plugin version, session, parent, fork source / point / kind, origin, spawning call;
  // prompt_cache_key on OpenAI bodies.
  const linksOf = (sessionId) => {
    const session = ctx.sessions.get?.(sessionId);
    return session ? { ...sessionLinks(session.header, session.inheritedEventCount), spawnToolCallId: spawnCalls.get(sessionId) } : undefined;
  };
  const headers = createRequestHeaders({ origins: [resolved.gatewayOrigin], skipPath: new URL(resolved.endpoint).pathname,
    version: PACKAGE.version, lookupLinks: linksOf, logger: ctx.logger,
    onKey: reuseRouteKey ? key => { if (key !== routeKey) { routeKey = key; exporter.flush(); } } : undefined });
  if (process.versions.bun !== undefined || !headers.start()) {
    ctx.logger.warn(`${name}: this runtime has no undici request channel; model requests go out without TokenRouter session headers`);
  } else {
    ctx.on('llm/stream', headers.onStream, { global: true });
    // Model calls made inside a tool call without their own session id (Auto review's reviewer, a web search) use the agent's.
    // Prepended: the outermost listener, around every other gate.
    for (const event of ['tools/pre-execute', 'tools/execute']) {
      ctx.on(event, (exec, next) => headers.inSession(exec?.agent?.session?.id, next), { global: true, prepend: true });
    }
  }

  ctx.effect(() => async () => {
    headers.stop();
    mappers.clear();
    try { await exporter.shutdown(); } catch (error) { ctx.logger.warn(`${name}: shutdown flush failed: ${String(error?.message ?? error)}`); }
  }, 'tokenrouter telemetry export');
}
