window.__ModuleLoader__.load({
  id: "@local/dsh-agent-dag",
  factory: require => {
    const { createElement: h, useEffect, useLayoutEffect, useState, useRef, useSyncExternalStore } = require("react");
    // Two-level model picker for the DSH composer: level 1 = code agent (DeepSeek Harness itself, or an
    // ACP agent from @zaimokuza/dsh-acp-adapter), level 2 = that agent's models (+ reasoning effort).
    // Same data and selection path as the stock picker (`modelDirectories` → directory store / select).
    function createAgentModelSelect({ h, useState, useEffect, useRef, useSyncExternalStore }) {
      const DSH = "dsh";
      // ACP groups come from the adapter as "<Agent> (TokenRouter) · ACP" with ids "acp-<agent>".
      const agentOf = group => /^acp-/.test(group.id) || / · ACP$/.test(group.name) ? group.id : DSH;
      const agentName = group => group.name.replace(/ · ACP$/, "").replace(/\s*\([^)]*\)\s*$/, "");
      function agentsOf(groups) {
        const agents = new Map([[DSH, { id: DSH, name: "DeepSeek Harness", groups: [] }]]);
        for (const group of groups) {
          const id = agentOf(group);
          if (!agents.has(id)) agents.set(id, { id, name: agentName(group), groups: [] });
          agents.get(id).groups.push(group);
        }
        return [...agents.values()].filter(agent => agent.groups.some(group => group.models.length));
      }
      const row = { display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 32, padding: "0 10px", border: "none", borderRadius: 6, background: "transparent", color: "var(--dsw-alias-label-primary, inherit)", font: "inherit", fontSize: 13, textAlign: "left", cursor: "pointer" };
      const muted = { color: "var(--dsw-alias-label-secondary, #888)", fontSize: 12 };

      return function AgentModelSelect({ available, directory, load, select, hideAccess }) {
        const state = useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot());
        const [open, setOpen] = useState(false), [pane, setPane] = useState("root"), [agentId, setAgentId] = useState(null);
        const [query, setQuery] = useState(""), [error, setError] = useState(""), [pos, setPos] = useState(null);
        const rootRef = useRef(null), menuRef = useRef(null), triggerRef = useRef(null);
        const agents = agentsOf(state.groups ?? []);
        const currentGroup = state.current ? (state.groups ?? []).find(group => group.id === state.current.provider) : undefined;
        const currentModel = currentGroup?.models.find(model => model.id === state.current.model);
        const currentAgent = currentGroup ? agents.find(agent => agent.id === agentOf(currentGroup)) : undefined;
        const reasoning = currentModel?.reasoning, effort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
        const effortName = reasoning ? reasoning.efforts.find(level => level.id === effort)?.name ?? (effort ? effort : "默认") : state.retainedEffort;
        // DSH's access mode (sandbox preset) never confines an ACP agent: the adapter spawns it unsandboxed and the
        // agent's own permission mode lives in the adapter's "<Agent> 权限" control. Hide the chip while an ACP
        // agent is selected so the only permission control shown is the one that takes effect.
        const acpSelected = currentAgent !== undefined && currentAgent.id !== DSH;
        useEffect(() => available && acpSelected ? hideAccess?.() : undefined, [available, acpSelected]);
        useEffect(() => {
          if (!open) return;
          const outside = event => { if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false); };
          const key = event => { if (event.key === "Escape") { event.preventDefault(); if (pane === "root") setOpen(false); else setPane(pane === "model" ? "agent" : "root"); } };
          document.addEventListener("mousedown", outside); document.addEventListener("keydown", key);
          const rect = triggerRef.current?.getBoundingClientRect(), menu = menuRef.current;
          if (rect) setPos({ left: Math.max(12, Math.min(rect.right - (menu?.offsetWidth ?? 300), window.innerWidth - (menu?.offsetWidth ?? 300) - 12)), top: Math.max(12, rect.top - 8 - (menu?.offsetHeight ?? 0)) });
          return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", key); };
        }, [open, pane, agentId, query, state.groups?.length]);
        if (!available) return null;
        const show = () => { setError(""); setQuery(""); setAgentId(currentAgent?.id ?? null); setPane(currentAgent ? "root" : "agent"); setOpen(!open); load(); };
        const submit = selection => {
          setError("");
          Promise.resolve(select(selection)).then(result => {
            if (result === undefined || result.ok) { setOpen(false); setPane("root"); return; }
            setError(result.error.code === "session/writer-held" ? "会话正在运行，稍后再切换" : `${result.error.code}: ${result.error.message}`);
          }, failure => setError(String(failure?.message ?? failure)));
        };
        const cell = (label, value, onClick, testId) => h("button", { type: "button", role: "menuitem", "data-testid": testId, onClick, style: row }, h("span", { style: { flex: 1 } }, label), h("span", { style: muted }, value ?? "—"), h("span", { style: muted }, "›"));
        const back = (label, to) => h("button", { type: "button", onClick: () => setPane(to), style: { ...row, ...muted } }, `‹ ${label}`);
        const chosen = agents.find(agent => agent.id === agentId) ?? currentAgent;
        let body;
        if (pane === "root") body = [
          cell("Code agent", currentAgent?.name, () => setPane("agent"), "agent-model-root-agent"),
          cell("模型", currentModel?.name, () => { setAgentId(currentAgent?.id ?? null); setPane("model"); }, "agent-model-root-model"),
          reasoning ? cell("推理等级", effortName, () => setPane("effort"), "agent-model-root-effort") : null,
        ];
        else if (pane === "agent") body = [
          currentAgent ? back("返回", "root") : null,
          ...agents.map(agent => h("button", { key: agent.id, type: "button", role: "menuitemradio", "aria-checked": agent.id === currentAgent?.id, "data-agent-id": agent.id, onClick: () => { setAgentId(agent.id); setQuery(""); setPane("model"); }, style: row },
            h("span", { style: { width: 14 } }, agent.id === currentAgent?.id ? "✓" : ""), h("span", { style: { flex: 1 } }, agent.name), h("span", { style: muted }, `${agent.groups.reduce((n, group) => n + group.models.length, 0)} 个模型 ›`))),
          state.status === "loading" && !agents.length ? h("div", { style: { ...row, ...muted } }, "读取模型…") : null,
        ];
        else if (pane === "model" && chosen) {
          const total = chosen.groups.reduce((n, group) => n + group.models.length, 0), q = query.trim().toLowerCase();
          body = [
            back(chosen.name, "agent"),
            total > 8 ? h("input", { key: "search", autoFocus: true, value: query, placeholder: "搜索模型", onChange: event => setQuery(event.target.value), style: { margin: "4px 8px", padding: "5px 8px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))", borderRadius: 6, background: "transparent", color: "inherit", font: "inherit", fontSize: 13 } }) : null,
            ...chosen.groups.flatMap(group => {
              const models = group.models.filter(model => !q || `${model.name} ${model.id}`.toLowerCase().includes(q));
              if (!models.length) return [];
              return [chosen.groups.length > 1 ? h("div", { key: `g:${group.id}`, role: "presentation", style: { ...muted, padding: "6px 10px 2px" } }, group.name) : null,
                ...models.map(model => { const on = state.current?.provider === group.id && state.current.model === model.id;
                  return h("button", { key: `${group.id}:${model.id}`, type: "button", role: "menuitemradio", "aria-checked": on, disabled: state.pending !== null, "data-provider-id": group.id, "data-model-id": model.id, onClick: () => on ? setOpen(false) : submit({ provider: group.id, model: model.id, ...effortFor(model, chosen.id === currentAgent?.id ? effort : undefined) }), style: row },
                    h("span", { style: { width: 14 } }, on ? "✓" : ""), h("span", { style: { flex: 1 } }, model.name)); })];
            }),
          ];
        } else if (pane === "effort" && reasoning) body = [
          back("推理等级", "root"),
          ...(reasoning.defaultEffort === undefined ? [{ id: undefined, name: "默认" }] : []).concat(reasoning.efforts).map(level => h("button", { key: level.id ?? "default", type: "button", role: "menuitemradio", "aria-checked": effort === level.id, onClick: () => submit({ provider: state.current.provider, model: state.current.model, ...level.id === undefined ? {} : { reasoningEffort: level.id } }), style: row },
            h("span", { style: { width: 14 } }, effort === level.id ? "✓" : ""), h("span", { style: { flex: 1 } }, level.name))),
        ];
        const label = state.current === null && state.status === "loading" ? "读取模型…" : currentModel ? `${currentAgent && currentAgent.id !== DSH ? `${currentAgent.name} · ` : ""}${currentModel.name}${effortName ? ` · ${effortName}` : ""}` : "选择模型";
        return h("div", { ref: rootRef, style: { position: "relative", minWidth: 0 }, "data-testid": "agent-model-select" },
          h("button", { ref: triggerRef, type: "button", "aria-haspopup": "menu", "aria-expanded": open, "aria-label": `选择 code agent 与模型，当前 ${label}`, onClick: show, style: { display: "flex", alignItems: "center", gap: 4, height: 28, maxWidth: "min(360px, 45cqw)", padding: "0 4px 0 8px", border: "none", borderRadius: 6, background: "transparent", color: "var(--dsw-alias-label-secondary, #888)", font: "inherit", fontSize: 13, cursor: "pointer" } },
            h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label), h("span", null, open ? "⌃" : "⌄")),
          open ? h("div", { ref: menuRef, role: "menu", "data-testid": "agent-model-menu", style: { position: "fixed", zIndex: 1000, left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: 300, maxHeight: "min(460px, 70vh)", overflowY: "auto", padding: 4, borderRadius: 10, background: "var(--dsw-alias-bg-layer-2, Canvas)", color: "var(--dsw-alias-label-primary, CanvasText)", boxShadow: "0 8px 28px rgba(0,0,0,.18)", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))", display: "flex", flexDirection: "column", gap: 1 } },
            ...body.filter(Boolean),
            error ? h("div", { role: "alert", style: { ...muted, color: "var(--dsw-alias-state-error-primary, #d33)", padding: "6px 10px" } }, error) : null) : null);
      };
    }
    // The effort a model selection carries. Without an explicit value DSH keeps the previous selection's
    // effort, which another agent may reject (Codex "max" → Oh My Pi fails the turn with ACP_CONFIG_UNSUPPORTED).
    // The catalog default is no safer: Oh My Pi's GPT-5.5 advertises "max" as default while its ACP session
    // refuses it. So: keep the current effort only within the same agent and only if the new model offers
    // it; otherwise the first of high / medium / low it offers, else its default.
    function effortFor(model, keep) {
      const reasoning = model.reasoning;
      if (!reasoning) return {};
      const ids = reasoning.efforts.map(level => level.id);
      const id = keep !== undefined && ids.includes(keep) ? keep : ["high", "medium", "low"].find(level => ids.includes(level)) ?? reasoning.defaultEffort ?? ids[0];
      return id === undefined ? {} : { reasoningEffort: id };
    }
    const AgentModelSelect = createAgentModelSelect({ h, useState, useEffect, useRef, useSyncExternalStore });
    // Extra pills in DSH's own composer stats row (conversation.composer.dock, next to its turn/step and token pills):
    // cost, family/inference, and plans DSH does not show. Same pill and dialog look: the class names are read from
    // DSH's injected CSS modules so a DSH update with new hashes keeps working.
    function createMeterPills({ h, useState, useEffect, useRef, useSyncExternalStore }) {
      const classes = {};
      const cls = (module, key) => {
        const id = `${module}:${key}`;
        if (id in classes) return classes[id];
        const text = document.querySelector(`style[data-plugin-css="@deepseek-ai/dsh-client-ui-chat/${module}.module.css"]`)?.textContent ?? "";
        return classes[id] = new RegExp(`\\.([\\w-]+_${key})(?![\\w-])`).exec(text)?.[1] ?? "";
      };
      const pillCls = key => cls("StatsPills", key), dialogCls = key => cls("stat-dialog", key);
      const muted = "var(--dsw-alias-label-secondary, #888)";
      const compact = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
      const sum = t => t.in + t.cacheRead + t.cacheWrite + t.out;
      const money = b => b.calls && b.unpriced.calls === b.calls ? "未定价" : `${b.currency === "USD" ? "$" : "¥"}${(b.currency === "USD" ? b.costUsd : b.costCny).toFixed(2)}`;
      const sec = (ms, src) => ms === null || ms === undefined ? "—" : `${src === "approx" ? "≈" : ""}${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
      const tps = (v, src) => v === null || v === undefined ? "—" : `${src === "approx" ? "≈" : ""}${Math.round(v)} t/s`;

      // One meter per session, shared by its pills; refetched when DSH's projection moves, polled while agents run.
      const stores = new Map();
      function storeFor(sessionId, load) {
        let store = stores.get(sessionId);
        if (store) { store.load = load; return store; }
        store = { load, value: null, error: "", listeners: new Set(), busy: false, again: false, at: 0, running: false, timer: null, poll: null, tick: "" };
        // Dropped a minute after its last pill unmounts: deleting synchronously would hand the next render a fresh
        // store (new subscribe identity) and loop resubscribing.
        store.subscribe = fn => {
          store.listeners.add(fn); clearTimeout(store.gc);
          return () => {
            store.listeners.delete(fn);
            if (!store.listeners.size) store.gc = setTimeout(() => { if (store.listeners.size) return; clearTimeout(store.timer); clearInterval(store.poll); store.poll = null; stores.delete(sessionId); }, 60_000);
          };
        };
        store.snapshot = () => store.state ?? (store.state = { value: store.value, error: store.error });
        store.fetch = () => {
          if (store.busy) { store.again = true; return; }
          store.busy = true; store.at = Date.now();
          store.load(store.running).then(value => { store.value = value; store.error = ""; }, failure => { store.error = String(failure?.message ?? failure); })
            .finally(() => {
              store.busy = false; store.state = null; for (const fn of store.listeners) fn();
              const live = store.running || store.value?.meter?.status === "ok" && store.value.meter.agents.some(row => row.running);
              if (live && !store.poll) store.poll = setInterval(store.fetch, 10_000);
              if (!live && store.poll) { clearInterval(store.poll); store.poll = null; }
              if (store.again) { store.again = false; setTimeout(store.fetch, 1500); }
              // The gateway lookup answers "loading" on first contact: ask again shortly, a few times at most.
              else if (store.value?.channels?.status?.state === "loading" && (store.channelRetries = (store.channelRetries ?? 0) + 1) <= 5) setTimeout(store.fetch, 3000);
            });
        };
        store.update = (tick, running) => {
          if (store.tick === tick) return;
          store.tick = tick; store.running = running;
          clearTimeout(store.timer);
          store.timer = setTimeout(store.fetch, Math.max(0, 3000 - (Date.now() - store.at)));
        };
        stores.set(sessionId, store);
        return store;
      }
      function useMeter({ sessionId, load, useProjection }) {
        const stats = useProjection("sessionStats");
        const running = !!stats && stats.openStep !== null && stats.openStep !== undefined;
        const store = useRef(null);
        if (store.current === null || store.current.id !== sessionId) store.current = Object.assign(storeFor(sessionId, load), { id: sessionId });
        const state = useSyncExternalStore(store.current.subscribe, store.current.snapshot);
        useEffect(() => { store.current.update(`${stats?.turns ?? 0}:${stats?.steps ?? 0}:${running}`, running); }, [sessionId, stats?.turns, stats?.steps, running]);
        return state.value?.meter?.status === "ok" ? state.value : null;
      }

      function Pill({ stat, label, title, titleValue, children }) {
        const [open, setOpen] = useState(false), [pos, setPos] = useState(null), rootRef = useRef(null), panelRef = useRef(null);
        useEffect(() => {
          if (!open) return;
          const place = () => {
            const anchor = rootRef.current?.getBoundingClientRect(), panel = panelRef.current;
            if (!anchor || !panel) return;
            const width = panel.offsetWidth, height = panel.offsetHeight;
            setPos({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)), top: Math.max(8, anchor.top - 8 - height) });
          };
          place();
          const key = event => { if (event.key === "Escape") setOpen(false); };
          const click = event => { if (!rootRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOpen(false); };
          document.addEventListener("keydown", key); document.addEventListener("click", click, true); window.addEventListener("resize", place);
          return () => { document.removeEventListener("keydown", key); document.removeEventListener("click", click, true); window.removeEventListener("resize", place); };
        }, [open]);
        const fallbackPanel = { padding: "10px 12px", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2, Canvas)", color: "var(--dsw-alias-label-primary, CanvasText)", boxShadow: "0 8px 28px rgba(0,0,0,.18)", fontSize: 12 };
        return h("span", { ref: rootRef, className: pillCls("anchor"), "data-composer-stat": stat },
          h("button", { type: "button", className: pillCls("pill"), "aria-haspopup": "dialog", "aria-expanded": open, onClick: () => setOpen(!open), style: pillCls("pill") ? undefined : { border: "none", background: "transparent", color: muted, font: "inherit", fontSize: 12, cursor: "pointer" } },
            h("span", { className: pillCls("label") }, label)),
          open ? h("div", { ref: panelRef, role: "dialog", "aria-label": title, className: dialogCls("panel"), style: { position: "fixed", zIndex: 1000, maxWidth: "min(520px, calc(100vw - 16px))", maxHeight: "60vh", overflowY: "auto", left: pos?.left ?? -9999, top: pos?.top ?? -9999, ...dialogCls("panel") ? {} : fallbackPanel } },
            h("div", { className: dialogCls("title") }, h("span", { className: dialogCls("titleLabel") }, title), titleValue !== undefined ? h("span", { className: dialogCls("titleValue") }, titleValue) : null),
            h("div", { className: dialogCls("titleRule"), "aria-hidden": true }),
            children) : null);
      }
      // dt/dd rows in DSH's details grid; `wide` rows put a secondary line under the term.
      const details = rows => h("dl", { className: dialogCls("details") }, ...rows.filter(Boolean).flatMap(([term, value, hint], i) => [
        h("dt", { key: `t${i}`, title: hint }, term), h("dd", { key: `d${i}`, style: { whiteSpace: "nowrap" } }, value)]));
      const note = text => h("p", { style: { margin: "8px 0 0", color: muted, fontSize: 11, lineHeight: 1.45 } }, text);

      // Second line under DSH's own stats row: whole-session (every agent) decode speed, tokens, cache, and the provider
      // and model in use. The dock is a single centered row; this entry wraps it and takes a line of its own.
      function StatsRow(props) {
        const data = useMeter(props), lineRef = useRef(null);
        useEffect(() => {
          const host = lineRef.current && [...function* () { for (let e = lineRef.current.parentElement; e; e = e.parentElement) yield e; }()].find(e => getComputedStyle(e).display === "flex");
          if (!host) return;
          const previous = host.style.flexWrap;
          host.style.flexWrap = "wrap";
          return () => { host.style.flexWrap = previous; };
        }, [!!data]);
        if (!data) return null;
        const { meter, familyAverages, direct, channels, channelError } = data;
        const family = meter.session.family, t = family.tokens, input = t.in + t.cacheRead + t.cacheWrite;
        const hit = input > 0 ? Math.round(t.cacheRead * 1000 / input) / 10 : null;
        const main = channels?.agents?.find(agent => agent.key === channels.rootKey) ?? channels?.agents?.[0];
        const model = main?.model ?? meter.agents[0]?.model ?? meter.lastCall?.model ?? null;
        const provider = direct ? "DeepSeek 官方" : main?.channel ?? null;
        const state = channels?.status?.state, matched = channels?.status?.matched ?? 0;
        const providerHint = direct ? "直连 DeepSeek 官方 API，不经 TokenRouter" : channelError ? `无法读取网关通道：${channelError}` : state === "loading" ? "正在读取网关通道" : state === "error" || state === "unavailable" ? `网关通道不可用：${channels.status.message ?? state}` : provider ? "TokenRouter 网关路由到的上游 Provider" : matched ? `网关已对上 ${matched} 次调用，但没有返回 Provider 名称（channel 为空）` : "网关还没有这些调用的记录";
        const avg = familyAverages ?? meter.averages;
        // ContextPerf: `tps` counts only trustworthy stream samples (often null); `wallTps` is the
        // end-to-end request-window lower bound, so it leads and `tps` stays as the fallback.
        const wallSpeed = avg.wallTps !== null && avg.wallTps !== undefined ? `≥ ${tps(avg.wallTps)}` : null;
        const sampleSpeed = avg.tps !== null && avg.tps !== undefined ? tps(avg.tps) : null;
        const pieces = [
          wallSpeed ?? sampleSpeed,
          `${compact(sum(t))} tok`,
          `缓存 ${compact(t.cacheRead)}${hit !== null ? `（${hit}%）` : ""}`,
          h("span", { key: "p", title: providerHint }, `Provider ${provider ?? (state === "loading" ? "读取中" : "未知")}${model ? ` · ${model}` : ""}`),
        ].filter(Boolean);
        const label = pieces.flatMap((p, i) => i ? [h("span", { key: `s${i}`, className: pillCls("sep"), "aria-hidden": true, style: pillCls("sep") ? undefined : { opacity: .5, margin: "0 4px" } }, "·"), p] : [p]);
        const subagents = family.calls > meter.session.main.calls;
        const running = channels?.agents?.filter(agent => agent.key !== channels.rootKey && agent.running) ?? [];
        // Calibrated timing: `wallTps` is the end-to-end request-window lower bound (marked "≥",
        // includes buffered calls); `tps`, trustworthy decode samples only, is the fallback.
        const speed = wallSpeed ?? sampleSpeed ?? "—";
        const buffered = avg.bufferedCalls ?? 0;
        return h("span", { ref: lineRef, "data-agent-dag-stats": "", style: { flexBasis: "100%", order: 100, display: "flex", justifyContent: "center", minWidth: 0, marginTop: -2 } },
          h(Pill, { stat: "agent-dag-total", label, title: subagents ? "总计（含子代理）" : "总计", titleValue: `${compact(sum(t))} tok` },
            details([
              ["decode 均速", `${speed} · ${avg.decodeCounts.measured + avg.decodeCounts.approx + buffered} 次调用${buffered > 0 ? `（含 ${buffered} 次缓冲调用，无逐流采样）` : ""}`],
              ["首字中位", sec(avg.medianTtftMs)],
              ["输入 / 输出", `${compact(t.in)} / ${compact(t.out)}`],
              ["缓存读 / 写", `${compact(t.cacheRead)} / ${compact(t.cacheWrite)}${hit !== null ? ` · 命中 ${hit}%` : ""}`],
              subagents ? ["主代理", `${compact(sum(meter.session.main.tokens))} tok · ${meter.session.main.calls} 次`, "DSH 上一行的 tok 只统计主代理"] : null,
              ["费用（估算）", `${money(family)} · ${family.calls} 次调用`, `${meter.priceSource ?? "价格 API 不可用"}；按记录 token 估算，不是账单`],
              ["Provider", provider ?? "未知", providerHint],
              ...running.map(agent => [agent.label, `${agent.channel ?? "未知"}${agent.model ? ` · ${agent.model}` : ""}`]),
            ]),
            note(`${providerHint}。TPS = 输出 / decode 时长；均速优先显示 ≥ 请求窗口下界（端到端，缓冲调用计入窗口），没有窗口证据时才回落到只统计可信流式采样（decode ≥200ms 且覆盖 ≥¼ 请求窗口）的 tps。`)));
      }
      return { StatsRow };
    }
    const MeterPills = createMeterPills({ h, useState, useEffect, useRef, useSyncExternalStore });
    // Settings panel for the code agents' model defaults: the model each agent starts new
    // sessions on, and the model its subagents use. The server half (models.js) owns every
    // service call and file write — this panel only reads current values and asks for a change.
    // Registered in DSH's own Models settings page and on this bundle's page under Plugins.
    function createModelConfig({ h, useState, useEffect, call }) {
      const muted = { color: "var(--dsw-alias-label-secondary, #888)", fontSize: 12, lineHeight: 1.5 };
      const card = { display: "flex", flexDirection: "column", gap: 5, padding: "10px 12px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))", borderRadius: 10 };
      const small = { ...muted, padding: "3px 8px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))", borderRadius: 6, background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" };
      const item = { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "5px 8px", border: "none", borderRadius: 6, background: "transparent", color: "inherit", font: "inherit", fontSize: 13, textAlign: "left", cursor: "pointer" };
      const ROLE_LABEL = { main: "主模型（新会话默认）", subagent: "子代理模型" };
      /** `agentDefaultModel` names a provider, so DSH's own main model carries the group it came from. */
      const providerOf = (state, model) => state.catalog.find(group => group.agent === "dsh" && group.models.some(entry => entry.id === model))?.id;
      function ModelConfigPanel(props) {
        const [state, setState] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(""), [open, setOpen] = useState(""), [done, setDone] = useState(null);
        const load = () => call("agent-model/read", {}).then(value => { setState(value); setError(""); }, failure => setError(failure.message));
        useEffect(() => { load(); }, []);
        if (props?.view === "summary") return h("span", { style: muted }, "各 code agent 的主模型与子代理模型默认值");
        const save = (agent, role, model) => {
          setBusy(`${agent}:${role}`); setDone(null);
          call("agent-model/save", { agent, role, model, provider: agent === "dsh" && role === "main" ? providerOf(state, model) : void 0 }).then(value => {
            setDone(value); setOpen(""); setBusy(""); setError("");
            return load();
          }, failure => { setError(failure.message); setBusy(""); });
        };
        const describe = value => {
          const bits = value.written === false ? ["值没有变化，未改动文件"] : value.write ? [`已写入 ${value.write}：${value.model}`] : [];
          if (value.backup?.length) bits.push(`原文件已备份为 ${value.backup.map(path => path.split("/").pop()).join("、")}`);
          if (value.notice) bits.push(value.notice);
          return bits.concat(value.extra ?? []).join("；");
        };
        const row = (agent, role) => {
          const key = `${agent.id}:${role}`, info = agent[role], options = agent.options[role] ?? [];
          const current = options.find(option => option.id === info.model);
          return h("div", { key, style: { display: "flex", flexDirection: "column", gap: 2 } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
              h("span", { style: { ...muted, minWidth: 128 } }, ROLE_LABEL[role]),
              h("span", { style: { flex: 1, fontSize: 13, overflowWrap: "anywhere" } }, current ? (current.name === current.id ? current.name : `${current.name} · ${current.id}`) : info.model ?? (role === "main" ? "未设置（跟随该 agent 自己的默认）" : "未设置（子代理沿用父代理的模型）")),
              h("button", { type: "button", "data-testid": `model-config-${agent.id}-${role}`, disabled: busy === key, onClick: () => setOpen(open === key ? "" : key), style: small }, busy === key ? "写入中…" : open === key ? "收起" : "更改")),
            h("div", { style: muted }, info.source),
            open === key ? h("div", { role: "menu", style: { display: "flex", flexDirection: "column", gap: 1, marginTop: 4, maxHeight: 240, overflowY: "auto", padding: 4, border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))", borderRadius: 8 } },
              ...options.map(option => h("button", { key: option.id, type: "button", role: "menuitemradio", "aria-checked": option.id === info.model, "data-model-id": option.id, onClick: () => save(agent.id, role, option.id), style: item },
                h("span", { style: { width: 14 } }, option.id === info.model ? "✓" : ""),
                h("span", { style: { flex: 1 } }, option.name),
                option.name === option.id ? null : h("span", { style: muted }, option.id),
                option.offCatalog ? h("span", { style: muted }, "目录外") : null)),
              options.length === 0 ? h("div", { style: { ...muted, padding: "6px 8px" } }, "DSH 当前没有列出这个 agent 的可用模型") : null) : null);
        };
        if (error && !state) return h("div", { role: "alert", style: { padding: 12, ...muted } }, `读取模型配置失败：${error}`);
        if (!state) return h("div", { style: { padding: 12, ...muted } }, "正在读取各 code agent 的模型配置…");
        return h("div", { "data-testid": "model-config-panel", style: { display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" } },
          h("div", { style: { ...muted, fontSize: 13 } }, "每一项都写进该 agent 自己的配置或 DSH 配置，写入前先备份原文件；改完新建一个会话就按新值走，已在运行的会话继续用旧值。"),
          ...state.agents.map(agent => h("section", { key: agent.id, "data-agent": agent.id, style: card },
            h("div", { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
              h("span", { style: { fontSize: 13, fontWeight: 600 } }, agent.label),
              h("span", { style: muted }, agent.kind),
              agent.path ? h("code", { style: { ...muted, overflowWrap: "anywhere" } }, agent.path) : null),
            agent.error ? h("div", { style: { ...muted, color: "var(--dsw-alias-state-error-primary, #d33)" } }, agent.error) : null,
            row(agent, "main"), row(agent, "subagent"),
            h("div", { style: muted }, agent.applies),
            ...agent.notes.map((note, index) => h("div", { key: index, style: muted }, `· ${note}`)),
            done?.agent === agent.id ? h("div", { "data-testid": `model-config-result-${agent.id}`, style: { fontSize: 12, lineHeight: 1.5, color: "var(--dsw-alias-state-success-primary, #1a7f37)" } }, describe(done)) : null)),
          error ? h("div", { role: "alert", style: { ...muted, color: "var(--dsw-alias-state-error-primary, #d33)" } }, error) : null,
          h("button", { type: "button", onClick: load, style: { ...small, alignSelf: "flex-start" } }, "重新读取"));
      }
      return ModelConfigPanel;
    }
    // Sidebar session rows and the conversation header: which agent a session belongs to.
    // Imported Claude Code / Codex / Oh My Pi sessions and sessions bound to an ACP route show
    // that agent; everything else is DSH's own agent. Both seats share one poll, and the same
    // pass notices that the plugin imported a new session and asks the session list to reload.
    function createAgentMarks({ h, useEffect, call, context }) {
      const BADGE = { dsh: ["D", "DeepSeek Harness"], claude: ["A", "Claude Code"], codex: ["C", "Codex"], omp: ["O", "Oh My Pi"] };
      const COLORS = { dsh: "#3b82f6", claude: "#d97757", codex: "#10a37f", omp: "#a855f7" };
      const store = { kinds: {}, version: 0, snapshot: { kinds: {}, version: 0 }, listeners: new Set(), timer: null, mounted: 0, sessions: null };
      const read = () => store.snapshot;
      const notify = () => { store.snapshot = { kinds: store.kinds, version: store.version }; for (const listener of store.listeners) listener(); };
      // Every session a seat is showing is asked about, plus the rest of the list up to a cap; asking
      // only for a tail of the list left most visible rows unresolved (shown as "D") once a profile
      // held more sessions than the cap.
      const shown = new Set();
      const poll = async () => {
        const listed = store.sessions?.list?.getSnapshot?.()?.ids ?? [];
        const ids = [...new Set([...shown, ...listed])].slice(0, 4000);
        const result = await call("agent-dag/sessionMarks", { sessionIds: ids });
        const imported = result.version !== store.version;
        store.kinds = result.kinds ?? {};
        store.version = result.version ?? 0;
        // A pass that imported sessions changed DSH's session list; it must be re-read to show them.
        if (imported && store.sessions?.refreshList) store.sessions.refreshList();
        notify();
      };
      const useKinds = () => useSyncExternalStore(listener => { store.listeners.add(listener); return () => store.listeners.delete(listener); }, read);
      const usePolling = sessionId => useEffect(() => {
        store.sessions ??= context.get("sessions") ?? null;
        const fresh = sessionId !== "header" && !shown.has(sessionId) && !(sessionId in store.kinds);
        if (sessionId !== "header") shown.add(sessionId);
        store.mounted += 1;
        if (fresh && store.timer !== null) { clearTimeout(store.soon); store.soon = setTimeout(() => { poll().catch(() => {}); }, 150); }
        if (store.timer === null) {
          poll().catch(() => {});
          store.timer = setInterval(() => { poll().catch(() => {}); }, 10000);
        }
        return () => {
          if (sessionId !== "header") shown.delete(sessionId);
          store.mounted -= 1;
          if (store.mounted === 0 && store.timer !== null) { clearInterval(store.timer); store.timer = null; }
        };
      }, [sessionId]);
      const mark = (kind, seat) => {
        const [label, tip] = BADGE[kind] ?? BADGE.dsh;
        return h("span", { "data-agent-mark": kind, "data-agent-mark-seat": seat, title: tip, style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: 4, fontSize: 9, lineHeight: 1, fontWeight: 600, color: "#fff", background: COLORS[kind] ?? COLORS.dsh, opacity: 0.9 } }, label);
      };
      /** Sidebar row leading seat: the badge of the session the row is about. */
      function AgentMark({ sessionId }) {
        const snap = useKinds(); usePolling(sessionId);
        return mark(snap.kinds[sessionId] ?? "dsh", "sidebar");
      }
      /** Conversation header leading seat: the badge sits left of the title. That seat is
       * root-scoped, so the current session is read the way DSH's own document title does it:
       * the session retained by the main view, and only while no global panel covers the
       * conversation. A blank (hero) session keeps its title hidden, so the badge stays hidden too. */
      function AgentHeaderMark({ useSessions, usePanelInfo }) {
        const snap = useKinds(); usePolling("header");
        const show = usePanelInfo(info => info.activePanelId === null);
        const sessionId = useSessions(state => {
          const entry = Object.values(state.byId).find(row => (row.retainedBy.mainView ?? 0) > 0);
          return entry === undefined || entry.blank === true ? undefined : entry.id;
        });
        if (!show || sessionId === undefined) return null;
        return mark(snap.kinds[sessionId] ?? "dsh", "header");
      }
      return { AgentMark, AgentHeaderMark };
    }
    // The conversation header's action cluster copies a session's identifiers in one click: the DSH
    // session id always, plus the native agent session id for ACP-bound sessions (the plugin host
    // pairs them from the import state and the ACP sidecar's bindings, the same table the Agent DAG
    // source switch reads). One lookup per session, cached — ids never change for a session. Copy uses
    // the async clipboard with a selection fallback for hosts where it is unavailable.
    function createSessionIdCopy({ h, useEffect, useRef, useState, call }) {
      const cache = new Map();
      const remember = (sessionId, value) => {
        if (cache.size >= 256) cache.delete(cache.keys().next().value);
        cache.set(sessionId, value);
      };
      const copyText = async text => {
        try {
          if (navigator.clipboard?.writeText !== undefined) { await navigator.clipboard.writeText(text); return; }
        } catch (error) { /* fall through to the selection copy */ }
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        let copied = false;
        try { copied = document.execCommand("copy") === true; } catch (error) { copied = false; }
        area.remove();
        if (!copied) throw new Error("剪贴板不可用");
      };
      const chipStyle = { display: "inline-flex", alignItems: "center", height: 22, padding: "0 7px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))", borderRadius: 6, background: "transparent", color: "var(--dsw-alias-label-secondary, #888)", font: "inherit", fontSize: 11, lineHeight: 1, whiteSpace: "nowrap", cursor: "pointer" };
      const KIND_NAMES = { claude: "Claude Code", codex: "Codex", omp: "Oh My Pi" };
      return function SessionIdCopy({ sessionId }) {
        const [value, setValue] = useState(() => sessionId === undefined ? null : cache.get(sessionId) ?? null);
        const [error, setError] = useState("");
        const [copied, setCopied] = useState(null);
        const timer = useRef(null);
        useEffect(() => {
          if (sessionId === undefined) return undefined;
          if (cache.has(sessionId)) { setValue(cache.get(sessionId)); setError(""); return undefined; }
          let live = true;
          setValue(null); setError("");
          call("agent-dag/sessionIdentity", { sessionId }).then(
            result => { if (!live) return; remember(sessionId, result); setValue(result); },
            failure => { if (live) setError(String(failure?.message ?? failure)); });
          return () => { live = false; };
        }, [sessionId]);
        useEffect(() => () => { clearTimeout(timer.current); }, []);
        if (sessionId === undefined) return null;
        const write = (which, text) => { copyText(text).then(
          () => { setCopied(which); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(null), 1200); },
          failure => setError(String(failure?.message ?? failure))); };
        const native = value?.nativeSessionId ?? null;
        return h("span", { "data-session-copy": "chips", style: { display: "inline-flex", alignItems: "center", gap: 4 } },
          h("button", { type: "button", "data-session-copy": "dsh", title: error === "" ? `复制 DSH 会话 ID：${sessionId}` : `复制 DSH 会话 ID：${sessionId}（原生会话 ID 不可用：${error}）`, onClick: () => write("dsh", sessionId), style: chipStyle }, copied === "dsh" ? "已复制" : "复制 ID"),
          native === null ? null : h("button", { type: "button", "data-session-copy": "native", title: `复制 ${KIND_NAMES[value?.kind] ?? "Agent"} 原生会话 ID：${native}`, onClick: () => write("native", native), style: chipStyle }, copied === "native" ? "已复制" : "复制原生 ID"));
      };
    }
    const id = "@local/dsh-agent-dag";
    function Body({ sessionId, loadPanel }) {
      const [entry, setEntry] = useState(null), [error, setError] = useState("");
      useEffect(() => {
        const controller = new AbortController();
        setEntry(null); setError("");
        loadPanel(controller.signal).then(result => { if (!controller.signal.aborted) setEntry(result); }, error => { if (!controller.signal.aborted) setError(error.message); });
        return () => controller.abort();
      }, [sessionId, loadPanel]);
      // The embedded panel cannot reach the user's browser from inside its sandboxed iframe, so it
      // asks this page to open its own origin: the desktop shell turns window.open("http:…") into
      // the OS default browser. Only the panel origin may be opened this way.
      useEffect(() => {
        if (!entry) return undefined;
        let origin = null;
        try { origin = new URL(entry.url).origin; } catch { return undefined; }
        const onMessage = event => {
          if (event.origin !== origin) return;
          const data = event.data;
          if (!data || data.type !== "agent-dag/open-in-browser" || typeof data.url !== "string") return;
          let url;
          try { url = new URL(data.url); } catch { return; }
          if (url.protocol !== "http:" || url.origin !== origin) return;
          window.open(url.href, "_blank", "noopener,noreferrer");
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, [entry?.url]);
      return h("div", { style: { height: "100%", display: "flex", flexDirection: "column", minWidth: 0 }, "data-agent-dag-session": sessionId },
        entry?.notice ? h("div", { style: { padding: "6px 12px", fontSize: 12, color: "var(--dsw-alias-label-secondary, #888)" } }, entry.notice) : null,
        error ? h("p", { role: "alert", style: { padding: 12 } }, error) : entry ? h("iframe", { title: "Agent DAG", src: entry.url, sandbox: "allow-scripts allow-same-origin allow-forms", referrerPolicy: "no-referrer", style: { border: 0, width: "100%", flex: 1, minHeight: 0, background: "#101114" } }) : h("p", { style: { padding: 12 } }, "正在读取当前会话…"));
    }
    // The Agent DAG tab owns the conversation's bottom area, so while it is the active view the
    // resident composer must not render. `conversation.composer` is the chain slot for such
    // takeovers; the view component mounts only while its tab is selected, so a layout effect
    // registers an emptying takeover for exactly this session and drops it again on unmount.
    // Unanswered approvals and questions keep the seat: only a plain composer is hidden.
    function createComposerGate({ ctx, h, useLayoutEffect }) {
      const HIDDEN = "agent-dag/hidden-composer";
      function HiddenComposer() { return null; }
      return function AgentDagTab({ sessionId, loadPanel }) {
        useLayoutEffect(() => {
          if (sessionId === undefined) return undefined;
          return ctx.slots.inject("conversation.composer", () => ctx.slots.register({
            name: "conversation.composer", priority: -1000,
            select: owner => owner.sessionId === sessionId && owner.pendingInteraction === undefined ? HIDDEN : null
          }, HiddenComposer));
        }, [sessionId]);
        return h(Body, { sessionId, loadPanel });
      };
    }
    // ---------------------------------------------------------------------------------------------
    // Chat: every tool call shows its one-line summary without a click, and exactly once.
    //
    // Fold seat: DSH folds each Turn's work behind collapsed group disclosures ("Called tools", "Ran
    // commands", …) and folds a completed Turn behind its "Completed in …" row. The user wants the
    // one-line summary of every tool call visible by default while keeping the app's own collapse
    // affordances (a later click still folds a group, or the whole Turn, again). No chat setting
    // controls that default — the "Work details" modes either keep the groups collapsed
    // (Standard/Detailed/Compact) or drop the groups and with them every collapse button (Verbose) —
    // so this seat drives the app's own controls once per Turn and per group: the `[data-turn-process]`
    // "Completed in …" toggle (TurnProcessNodeView) and the `[data-step-process]` group header. Both
    // are the same accessible buttons a reader clicks. Every action is keyed by session + Turn/group
    // identity, so a manual collapse is never undone again.
    //
    // Synthetic-turn seat: the host-side supplement (live-tools.js) appends, for each settled ACP
    // turn, a synthetic tool-only Turn to the session log whose rows carry `derived-` call ids —
    // Trajectory reads the log and needs that Turn. Chat already renders the same calls through the
    // adapter's own activity cards, so the synthetic Turn must not repeat them here. A Turn is
    // recognized from the flow's own rendered rows — the call id sits in `data-chat-node-key`
    // (`15:tool-callderived-…`), and every Chat row of a Turn carries `data-chat-turn` — and its rows
    // are parked with `hidden`, the attribute the app itself skips in paging and jump-to-turn lookups;
    // the Turn's empty trailing row stays as the paging anchor. The synthetic-turn seat never touches
    // the Trajectory view.
    //
    // Retry-noise seat: DSH writes each failed model request attempt as `assistant/attempt` and each
    // scheduled retry as `llm/retry`; Chat renders a `model-retry` row per retry, and the Trajectory
    // request summary repeats the last attempt's error, retry number and delay. That is internal
    // attempt bookkeeping, not conversation, and the user asked for it out of Chat and the Trajectory
    // (the Agent DAG reader stopped recording the same facts). The turn's own error row is the real
    // outcome and stays. Chat rows are parked with `hidden`; Trajectory summary rows are matched by
    // their detail label in either locale and parked the same way, and every pass re-checks, because
    // React may reuse a summary row's node for another label.
    //
    // All seats share one mutation schedule, hiding before folding.
    function installChatShowThrough() {
      const FLOW = '[data-slot="conversation.chat.flow"]';
      const TURN = "[data-turn-process]";
      const GROUP = "[data-step-process]";
      // A supplement-written row's node key is `<seq>:tool-call(…)derived-<native id>`; the prefix is
      // this plugin's own marking (the importer writes `imported-`, which Chat should keep).
      const DERIVED = /tool-(?:call|result)derived-/u;
      const COALESCE_MS = 120;
      // A control the reader toggles themselves (a trusted click) is remembered per element and left
      // alone from then on. DSH itself folds a just-streamed step group about 180 ms after the turn
      // settles — that fold has no reader behind it, so the next pass opens the group again (the
      // collapsed state the old per-element "already expanded" memory kept forever). Weak sets keep
      // dead panes collectable.
      const readerToggles = new WeakSet();
      /** Mark the turn toggle / group header the reader clicked; programmatic (seat) clicks stay out. */
      const noteReaderToggle = event => {
        if (event.isTrusted !== true) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target === null) return;
        const button = target.closest("button[aria-expanded]");
        if (button === null || button.closest(FLOW) === null) return;
        if (button.matches(TURN)) readerToggles.add(button);
        const seat = button.closest(GROUP);
        if (seat !== null && seat.querySelector("button[aria-expanded]") === button) readerToggles.add(button);
      };
      document.addEventListener("click", noteReaderToggle, true);
      let timer = null, stopped = false;
      /** Park every Chat row of the supplement's synthetic tool Turns; unrelated views stay untouched. */
      const hideDerived = () => {
        try {
          for (const flow of document.querySelectorAll(FLOW)) {
            const derived = new Set();
            for (const row of flow.querySelectorAll("[data-chat-node-key]")) {
              if (!DERIVED.test(row.getAttribute("data-chat-node-key") ?? "")) continue;
              const turn = row.getAttribute("data-chat-turn");
              if (turn !== null) derived.add(turn);
            }
            if (derived.size === 0) continue;
            for (const row of flow.querySelectorAll("[data-chat-turn]")) {
              if (derived.has(row.getAttribute("data-chat-turn")) && row.getAttribute("data-chat-flow-kind") !== "turn-tail") row.hidden = true;
            }
          }
        } catch (error) { /* an unrecognized transcript must never break the page */ }
      };
      // The Trajectory request summary repeats a retried attempt's facts under these detail labels
      // (`details.lastAttemptError` / `details.retry` / `details.retryDelay` in both shipped locales).
      const RETRY_LABELS = { "上次尝试错误": true, "重试": true, "重试延迟": true, "Last attempt error": true, "Retry": true, "Retry delay": true };
      /** Park retry rows in Chat and retry detail rows in the Trajectory request summary. */
      const hideRetryNoise = () => {
        try {
          for (const row of document.querySelectorAll('[data-chat-flow-kind="model-retry"]')) row.hidden = true;
        } catch (error) { /* an unrecognized transcript must never break the page */ }
        try {
          // Un-park first, then re-park what still matches: a reused node may now hold another label.
          for (const row of document.querySelectorAll("[data-agent-dag-retry-parked]")) { row.hidden = false; row.style.display = ""; row.removeAttribute("data-agent-dag-retry-parked"); }
          for (const label of document.querySelectorAll("[data-summary-scroll-region] dt")) {
            if (RETRY_LABELS[(label.textContent ?? "").trim()] !== true) continue;
            const row = label.parentElement;
            if (row === null) continue;
            // The overview CSS gives these rows their own `display`, which beats the `[hidden]` rule;
            // an inline style is what actually parks the row.
            row.hidden = true;
            row.style.display = "none";
            row.setAttribute("data-agent-dag-retry-parked", "");
          }
        } catch (error) { /* a sealed Trajectory detail must never break the page */ }
      };
      const openDefaults = () => {
        hideDerived();
        hideRetryNoise();
        try {
          for (const flow of document.querySelectorAll(FLOW)) {
            // Both disclosure handlers focus the control they toggle, so remember the reader's focus
            // (usually the composer) and hand it back: streaming expansions must not take the caret.
            const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const clicked = [];
            for (const button of flow.querySelectorAll(TURN)) {
              // Rows this pass just parked are skipped: a hidden row has nothing to show.
              if (button.closest("[hidden]") !== null || button.disabled || button.getAttribute("aria-expanded") !== "false" || readerToggles.has(button)) continue;
              clicked.push(button);
              button.click();
            }
            for (const seat of flow.querySelectorAll(GROUP)) {
              const header = seat.querySelector("button[aria-expanded]");
              if (header === null || seat.closest("[hidden]") !== null || header.getAttribute("aria-expanded") !== "false" || readerToggles.has(header)) continue;
              clicked.push(header);
              header.click();
            }
            const active = document.activeElement;
            if (active instanceof HTMLElement && clicked.includes(active)) {
              if (focused !== null && focused.isConnected) focused.focus({ preventScroll: true });
              else active.blur();
            }
          }
        } catch (error) { /* a folded transcript must never break the page */ }
      };
      const schedule = () => { if (!stopped && timer === null) timer = setTimeout(() => { timer = null; openDefaults(); }, COALESCE_MS); };
      const observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-expanded"] });
      openDefaults();
      return () => { stopped = true; clearTimeout(timer); observer.disconnect(); document.removeEventListener("click", noteReaderToggle, true); };
    }
    return {
      inject: ["connection", "slots", "sessions", "remote", "remote.session"],
      apply(ctx) {
        // Show-through seat first: it only reads the chat DOM, so it needs no service of its own.
        ctx.effect(() => installChatShowThrough());
        const AgentDagTab = createComposerGate({ ctx, h, useLayoutEffect });
        ctx.effect(() => ctx.slots.inject("conversation.view", () => ctx.slots.register({
          name: "conversation.view", id: "agent-dag", order: 30, label: () => "Agent DAG",
          inject: sessionId => ({ loadPanel: async signal => {
            const result = await ctx.connection.rpc.call("/api", "agent-dag/url", { sessionId }, signal);
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
          } })
        }, AgentDagTab)));
        ctx.effect(() => ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
          name: "conversation.composer.dock", id: `${id}:stats`, order: 100,
          inject: sessionId => ({ sessionId, load: running => ctx.connection.rpc.call("/api", "agent-dag/meter", { sessionId, running }).then(result => { if (!result.ok) throw new Error(result.error.message); return result.value; }) })
        }, MeterPills.StatsRow)));
        // Sidebar session rows and the conversation header: the badge naming the agent that owns each
        // session, and the header's one-click copy chips for the DSH session id (plus the native agent
        // session id when the session is ACP-bound).
        const call = (method, payload) => ctx.connection.rpc.call("/api", method, payload).then(result => { if (!result.ok) throw new Error(result.error.message); return result.value; });
        ctx.effect(() => {
          const { AgentMark, AgentHeaderMark } = createAgentMarks({ h, useEffect, context: ctx, call });
          const SessionIdCopy = createSessionIdCopy({ h, useEffect, useRef, useState, call });
          const off = [];
          off.push(ctx.slots.inject("sidebar.session.row.leading", () => ctx.slots.register({ name: "sidebar.session.row.leading", id: `${id}:agent-mark`, order: 10 }, AgentMark)));
          off.push(ctx.slots.inject("conversation.header.leading", () => ctx.slots.register({ name: "conversation.header.leading" }, AgentHeaderMark)));
          off.push(ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({ name: "conversation.session.header.actions", id: `${id}:session-copy`, order: 30 }, SessionIdCopy)));
          return () => { for (const dispose of off) dispose?.(); };
        });
        // Composer model seat: code agent first, then its models. The stock picker
        // holds priority 0, so registering below it shadows it (lowest renders).
        ctx.inject(["slots", "modelDirectories"], scope => {
          const models = scope.modelDirectories, sessions = scope.sessions;
          // One shadow of the access-mode chip while any visible composer has an ACP agent selected
          // (a single slot admits one registration per priority, so it is reference-counted).
          let accessHolds = 0, accessRelease = null;
          const hideAccess = () => {
            if (accessHolds++ === 0) accessRelease = scope.slots.inject("conversation.input.permission", () => scope.slots.register({ name: "conversation.input.permission", priority: -1 }, () => null));
            let held = true;
            return () => { if (!held) return; held = false; if (--accessHolds === 0) { accessRelease?.(); accessRelease = null; } };
          };
          scope.slots.inject("conversation.input.model", () => scope.slots.register({
            name: "conversation.input.model", key: `${id}:agent-model`, priority: -1,
            inject: sessionId => {
              const directory = models.directoryFor(sessionId), available = sessions.subagentAddress(sessionId) === void 0;
              return { available, hideAccess, directory: directory.store, load: () => { if (available) directory.load().catch(() => {}); }, select: selection => available ? directory.select(selection) : Promise.resolve(void 0) };
            }
          }, AgentModelSelect));
        });
        // Code-agent model defaults: the same panel sits in DSH's own Models settings page and
        // on this bundle's page under Plugins. Both read/write through the plugin's RPC.
        ctx.effect(() => {
          const modelCall = (method, payload) => ctx.connection.rpc.call("/api", method, payload).then(result => { if (!result.ok) throw new Error(result.error.message); return result.value; });
          const ModelConfigPanel = createModelConfig({ h, useState, useEffect, call: modelCall });
          const off = [];
          off.push(ctx.slots.inject("settings.models.footer", () => ctx.slots.register({ name: "settings.models.footer", id: `${id}:code-agent-models`, order: 20, label: () => "各 code agent 的默认模型" }, ModelConfigPanel)));
          off.push(ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({ name: "plugins.bundle.config", key: id }, ModelConfigPanel)));
          return () => { for (const dispose of off) dispose?.(); };
        });
      }
    };
  }
});
