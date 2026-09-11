/**
 * dsh-rollout-select — verifier core.
 *
 * A faithful TypeScript→JavaScript port of llm-as-a-verifier's fine-grained
 * reward + Probabilistic Pivot Tournament (PPT) best-of-N selection:
 *
 *   https://github.com/llm-as-a-verifier/llm-as-a-verifier
 *
 * Fine-grained reward: instead of collapsing the verifier's judgement into one
 * discrete label, read its probability distribution over an ordered 20-point
 * letter scale (A..T, A=20 … T=1) via token-level logprobs and take the
 * expectation, normalized to [0, 1]. PPT then ranks candidates with O(Nk)
 * comparisons (ring pass → pivot selection → pivot rounds → Bradley-Terry).
 *
 * The verifier backend is any OpenAI-compatible chat/completions endpoint that
 * returns `logprobs.content[].top_logprobs` (DeepSeek's hosted API, vLLM,
 * SGLang, OpenAI). DeepSeek is the default and matches the reference repo's
 * self-verification verifier (`deepseek-v4-flash`, thinking enabled).
 */

export const GRANULARITY = 20
export const SCORE_FORMAT = 'LETTER_A_TO_T'
export const SCALE_DESCRIPTION = [
  'Rate how likely the agent correctly solved the task on a 20-point scale using letters A through T:',
  '  A = clearly and completely succeeded with verified output (best)',
  '  B-D = succeeded with only minor issues',
  '  E-G = above average, mostly correct with some issues',
  '  H-J = uncertain, leans toward success',
  '  K-M = uncertain, leans toward failure',
  '  N-P = below average, significant issues remain',
  '  Q-S = failed with some partial progress',
  '  T = clearly and completely failed (worst)',
].join('\n')

/** 变更程度量表：A=必须完全重写 … T=完全不变，归一化后与阈值（默认 0.8）比较。 */
export const CHANGE_SCALE_DESCRIPTION = [
  'Rate how much the user\'s goal has changed relative to the current evaluation rubric,',
  'using letters A through T:',
  '  A = goal changed completely — the rubric must be fully regenerated (highest change)',
  '  B-D = major goal change — regenerate',
  '  E-G = moderate change — mostly still applies, minor edit at most',
  '  H-J = slight change — keep',
  '  K-M = very slight change — keep',
  '  N-P = negligible change — keep',
  '  Q-S = almost no change — keep',
  '  T = no change at all — keep the rubric exactly (lowest change)',
].join('\n')

/** g=20 score-token scale: A=20 … T=1, both cases accepted. */
const VALID_TOKENS = {}
for (let i = 0; i < GRANULARITY; i++) {
  VALID_TOKENS[String.fromCharCode(65 + i)] = GRANULARITY - i
  VALID_TOKENS[String.fromCharCode(97 + i)] = GRANULARITY - i
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32). The reference uses Python's Mersenne
// Twister, so the *exact* ring for a given seed differs; determinism per seed
// (identical inputs → identical tournament) is preserved.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

// ---------------------------------------------------------------------------
// Prompt + score extraction
// ---------------------------------------------------------------------------

function buildPrompt(problem, traceA, traceB, criterion, groundTruthNote, scaleDescription = SCALE_DESCRIPTION) {
  return [
    'You are an expert evaluator of AI coding agents. ' +
      'You will see a task description and two agent trajectories, then ' +
      'evaluate them on ONE specific criterion, stated at the end.\n\n',
    `${groundTruthNote}\n\n`,
    `**Task:**\n${problem}\n\n`,
    `**Trajectory A:**\n${traceA}\n\n`,
    `**Trajectory B:**\n${traceB}\n\n`,
    `**Rating Scale:**\n${scaleDescription}\n\n`,
    `**Evaluation Guideline — ${criterion.name}:**\n${criterion.description}\n\n`,
    `Score each trajectory ONLY on this specific criterion ("${criterion.name}"). ` +
      'Ignore other aspects of the trajectory that are not relevant to it.\n\n',
    'Reason it through first, then END your reply with exactly these two lines ' +
      'and nothing after them. Replace each placeholder with a single letter A-T, ' +
      'keeping the spaces around the letter exactly as shown:\n',
    `<score_A> ${SCORE_FORMAT} </score_A>\n`,
    `<score_B> ${SCORE_FORMAT} </score_B>\n\n`,
    'Begin your analysis now.',
  ].join('')
}

/**
 * Locate the logprob distribution at the score-tag position. Some tokenizers
 * fuse the closing `>` with the letter (`>A`), so the exact tag is tried first,
 * then the tag without its trailing `>`. The LAST match wins: the verdict is
 * the score block at the end of the reply, not the model quoting the format
 * mid-analysis.
 */
function findTagLogprobs(tokens, positionLogprobs, tag) {
  if (!tokens || !positionLogprobs) return null
  for (const suffix of [tag, tag.slice(0, -1)]) {
    let found = null
    let textSoFar = ''
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i] ?? ''
      textSoFar += tok
      if (!tok.trim()) continue
      if (textSoFar.trimEnd().endsWith(suffix)) {
        if (i + 1 < positionLogprobs.length) found = positionLogprobs[i + 1]
      }
    }
    if (found) return found
  }
  return null
}

/**
 * Expected score over the verifier's token distribution at `tag`, normalized
 * to [0, 1]. Falls back to parsing the literal text token, then to 0.5.
 */
export function extractScore(text, tokens, positionLogprobs, tag) {
  const probs = {}
  const tagLp = findTagLogprobs(tokens, positionLogprobs, tag)
  if (tagLp) {
    for (const [tokStr, logprob] of tagLp) {
      let tok = String(tokStr).trim()
      if (tok.startsWith('>')) tok = tok.slice(1).trim() // DeepSeek fuses '>' with the letter
      if (tok in VALID_TOKENS) {
        const val = VALID_TOKENS[tok]
        const p = Math.exp(logprob)
        probs[val] = Math.max(probs[val] ?? 0, p)
      }
    }
  }
  if (Object.keys(probs).length > 0) {
    const minVal = 1
    const maxVal = GRANULARITY
    const totalP = Object.values(probs).reduce((s, v) => s + v, 0)
    const expected =
      Object.entries(probs).reduce((s, [v, p]) => s + Number(v) * p, 0) / totalP
    return maxVal > minVal ? (expected - minVal) / (maxVal - minVal) : 0.5
  }

  const tagName = tag.replace(/^<|>$/g, '')
  const re = new RegExp(`<${tagName}>\\s*(.+?)\\s*</${tagName}>`, 'gi')
  let match = null
  for (const m of (text ?? '').matchAll(re)) match = m
  if (match) {
    const tok = match[1].trim()
    let rawVal = VALID_TOKENS[tok]
    if (rawVal == null) {
      for (const [vt, val] of Object.entries(VALID_TOKENS)) {
        if (tok.toLowerCase() === vt.toLowerCase()) {
          rawVal = val
          break
        }
      }
    }
    if (rawVal != null) return (rawVal - 1) / (GRANULARITY - 1)
  }
  return 0.5
}

// ---------------------------------------------------------------------------
// Verifier backend client (direct fetch to an OpenAI-compatible endpoint).
// ---------------------------------------------------------------------------

async function resolveApiKey(ctx, apiKeyEnv) {
  try {
    if (ctx?.credentials && typeof ctx.credentials.resolve === 'function') {
      const resolved = await ctx.credentials.resolve(apiKeyEnv)
      if (resolved && resolved.value) return resolved.value
    }
  } catch (err) {
    ctx?.logger?.warn?.(`rollout-select: credentials.resolve failed: ${String(err)}`)
  }
  return process.env[apiKeyEnv] ?? ''
}

function anySignal(signals) {
  const arr = signals.filter(Boolean)
  if (arr.length === 0) return undefined
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(arr)
  return arr[0]
}

/**
 * fetch with bounded retry for transient failures: undici's generic
 * "fetch failed" (DNS/TLS/keep-alive hiccup), 5xx, and 429 all retry with
 * exponential backoff; 4xx (auth, bad request) is returned to the caller so it
 * surfaces the real HTTP error. After the retries are exhausted the LAST error
 * is rethrown with the endpoint name prefixed for diagnosis.
 */
async function fetchWithRetry(url, init, label, logger) {
  const attempts = 4
  let lastErr = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res = null
    try {
      res = await fetch(url, init)
    } catch (err) {
      lastErr = err
    }
    if (res) {
      if (res.ok || (res.status < 500 && res.status !== 429)) return res
      lastErr = new Error(`${label} HTTP ${res.status}`)
      try {
        await res.text()
      } catch {}
    }
    // 被中止（judge 超时 / 上游取消）时立即失败，不再退避重试。
    if (init?.signal?.aborted) {
      throw new Error(`${label} aborted (timeout/cancel)`)
    }
    if (attempt < attempts) {
      const delay = 500 * 2 ** (attempt - 1)
      logger?.warn?.(
        `rollout-select: ${label} attempt ${attempt}/${attempts} failed (${String(
          lastErr?.message ?? lastErr ?? '',
        ).slice(0, 140)}); retrying in ${delay}ms`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error(
    `rollout-select: ${label} request failed after ${attempts} attempts: ${String(
      lastErr?.message ?? lastErr ?? '',
    )}`,
  )
}

/**
 * 把一次 judge 直连 fetch 返回的 usage 累加到汇总桶。judge 走 OpenAI 兼容的
 * /chat/completions（DeepSeek 风格：prompt_tokens / completion_tokens /
 * prompt_cache_hit_tokens / prompt_cache_miss_tokens）；若端点返回 pi-ai 风格
 * { input, output, cacheRead, cacheWrite } 则退回该映射。缺失字段按 0 计。
 */
export function addUsage(acc, usage) {
  if (!usage || typeof usage !== 'object') return
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  if ('prompt_tokens' in usage || 'completion_tokens' in usage) {
    acc.promptTokens += num(usage.prompt_tokens)
    acc.completionTokens += num(usage.completion_tokens)
    acc.cacheHitTokens += num(usage.prompt_cache_hit_tokens)
    acc.cacheMissTokens += num(usage.prompt_cache_miss_tokens)
  } else {
    acc.promptTokens += num(usage.input) + num(usage.cacheRead)
    acc.completionTokens += num(usage.output)
    acc.cacheHitTokens += num(usage.cacheRead)
    acc.cacheMissTokens += num(usage.input)
  }
}

/**
 * 解析一次非流式 chat/completions 响应为统一结构（content 文本 + sampling 前
 * logprobs 的 tokens/positionLogprobs + usage）。供流式回退与非流式端点复用。
 */
function parseChatJson(json) {
  const choice = json.choices?.[0]
  if (!choice) throw new Error('rollout-select: verifier returned no choices')
  const text = choice.message?.content ?? ''
  let tokens = null
  let positionLogprobs = null
  const lpContent = choice.logprobs?.content
  if (Array.isArray(lpContent) && lpContent.length > 0) {
    tokens = []
    positionLogprobs = []
    for (const pos of lpContent) {
      tokens.push(pos.token ?? '')
      let alts = (pos.top_logprobs ?? []).map((a) => [a.token ?? '', a.logprob ?? -Infinity])
      if (alts.length === 0) alts = [[pos.token ?? '', pos.logprob ?? -Infinity]]
      positionLogprobs.push(alts)
    }
  }
  return { text, tokens, positionLogprobs, usage: json.usage ?? null, finishReason: choice.finish_reason ?? null }
}

/**
 * 流式读取 OpenAI 兼容 chat/completions 响应（SSE）。DeepSeek thinking 模式下
 * reasoning_content 走 delta.reasoning_content（不进 logprobs、不计入 content），
 * 最终答案走 delta.content（逐 token 进 logprobs）；usage 依赖
 * stream_options.include_usage 在末尾 data 块返回。同时测量首 token 时延
 * （ttftMs = 首个 data 事件到达与流开始之间的墙钟差）。
 */
async function readSseChat(res, t0) {
  const reader = res.body?.getReader?.()
  if (!reader) throw new Error('rollout-select: verifier stream body unavailable')
  const decoder = new TextDecoder()
  let buffer = ''
  let firstTokenAt = null
  let content = ''
  const tokens = []
  const positionLogprobs = []
  let usage = null
  let finishReason = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (firstTokenAt === null) firstTokenAt = Date.now()
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let chunk
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }
      if (chunk?.usage) usage = chunk.usage
      const choice = chunk?.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string') content += delta.content
      if (choice.finish_reason) finishReason = choice.finish_reason
      const lpContent = choice.logprobs?.content
      if (Array.isArray(lpContent)) {
        for (const pos of lpContent) {
          tokens.push(pos.token ?? '')
          let alts = (pos.top_logprobs ?? []).map((a) => [a.token ?? '', a.logprob ?? -Infinity])
          if (alts.length === 0) alts = [[pos.token ?? '', pos.logprob ?? -Infinity]]
          positionLogprobs.push(alts)
        }
      }
    }
  }
  return {
    text: content,
    tokens,
    positionLogprobs,
    usage,
    finishReason,
    ttftMs: firstTokenAt !== null ? firstTokenAt - t0 : null,
  }
}

export function createApi(ctx, config, getJudgeBackend) {
  // The judge backend is resolved PER CALL (and per session) so runtime settings
  // (selected endpoint + model + reasoning effort) take effect immediately,
  // without a reload. `getJudgeBackend(sessionId)` returns { baseUrl, apiKeyEnv,
  // model, reasoningEffort } for the judge selected in that session.
  const getVerifier = (sessionId) => {
    const b = (typeof getJudgeBackend === 'function' ? getJudgeBackend(sessionId) : null) ?? {}
    return {
      baseUrl: String(b.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
      apiKeyEnv: b.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
      model: b.model ?? 'deepseek-v4-flash',
      reasoningEffort: b.reasoningEffort ?? 'off',
    }
  }

  return {
    async call(prompt, model, signal, sessionId, timeoutMs) {
      const verifier = getVerifier(sessionId)
      const isOff = ['off', 'disabled', 'none'].includes(String(verifier.reasoningEffort).toLowerCase())
      const key = await resolveApiKey(ctx, verifier.apiKeyEnv)
      if (!key) {
        throw new Error(
          `rollout-select: no verifier API key — resolve '${verifier.apiKeyEnv}' ` +
            'via the credentials service (or the environment) and retry',
        )
      }
      const body = {
        model: model ?? verifier.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: config.maxTokens ?? 32768,
        temperature: 1.0,
        logprobs: true,
        top_logprobs: config.topLogprobs ?? 20,
        thinking: isOff ? { type: 'disabled' } : { type: 'enabled' },
        // 流式读取以测量 judge 首 token 时延；include_usage 让 usage 随末尾 data 块返回。
        stream: true,
        stream_options: { include_usage: true },
      }
      if (!isOff) body.reasoning_effort = verifier.reasoningEffort

      // 首 token 时延从请求发出（含网络往返与排队）开始计，与 fanout 的
      // winnerWallMs - winnerDecodeMs 口径一致，便于两阶段直接对比。
      // 每次 judge 调用的墙钟上限（默认 30s）：超时即中止（含流式读取），避免个别
      // 请求挂起数分钟拖垮整轮。超时/失败在 scoreDirectedPairs 里按「随机判一方胜」
      // 兜底。
      const timeoutMsNum = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000
      const timeoutCtrl = new AbortController()
      const timeoutTimer = setTimeout(() => timeoutCtrl.abort(), timeoutMsNum)
      try {
        const t0 = Date.now()
        const res = await fetchWithRetry(
          `${verifier.baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: anySignal([signal, timeoutCtrl.signal]),
          },
          `verifier(${verifier.model})`,
          ctx?.logger,
        )
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 500)
          throw new Error(`rollout-select: verifier HTTP ${res.status}: ${detail}`)
        }

        const contentType = String(res.headers?.get?.('content-type') ?? '').toLowerCase()
        let parsed
        if (contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson')) {
          parsed = await readSseChat(res, t0)
        } else {
          // 端点忽略了 stream:true（返回一次性 JSON），退回到非流式解析；此时无首 token 时延。
          parsed = parseChatJson(await res.json())
          parsed.ttftMs = null
        }

        if (!parsed.positionLogprobs || parsed.positionLogprobs.length === 0) {
          throw new Error(
            `rollout-select: verifier returned no answer logprobs (finish_reason=${String(
              parsed.finishReason,
            )}); this judge endpoint does not expose pre-sampling logprobs`,
          )
        }
        return {
          text: parsed.text,
          tokens: parsed.tokens,
          positionLogprobs: parsed.positionLogprobs,
          usage: parsed.usage,
          ttftMs: parsed.ttftMs,
        }
      } finally {
        clearTimeout(timeoutTimer)
      }
    },

    /**
     * One rollout: a single DIVERSE completion from the generator model
     * (temperature 1.0). This is the SAMPLING step of best-of-N — it needs no
     * logprobs, only the generated text (reasoning + final answer). Call it N
     * times in parallel to obtain N independent rollouts, then rank them with
     * `selectBest`/`selectBestDetailed`.
     */
    async generateRollout(prompt, model, signal) {
      const verifier = getVerifier()
      const key = await resolveApiKey(ctx, verifier.apiKeyEnv)
      if (!key) {
        throw new Error(
          `rollout-select: no generator API key — resolve '${verifier.apiKeyEnv}' ` +
            'via the credentials service (or the environment) and retry',
        )
      }
      const body = {
        model: model ?? verifier.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: config.maxTokens ?? 32768,
        temperature: 1.0,
        // The generator disables the reasoning transcript: tokenrouter's
        // deepseek-v4-pro is extremely slow in "thinking" mode (the reasoning
        // chain is streamed slowly and max_tokens does not bound it), which
        // would make parallel sampling take minutes per rollout. With thinking
        // disabled the SAME main model still reasons internally and returns a
        // complete answer in a few seconds; only the visible reasoning trace
        // is dropped.
        thinking: { type: 'disabled' },
      }

      const res = await fetchWithRetry(
        `${verifier.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: signal,
        },
        `generator(${verifier.model})`,
        ctx?.logger,
      )
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500)
        throw new Error(`rollout-select: generator HTTP ${res.status}: ${detail}`)
      }
      const json = await res.json()
      const choice = json.choices?.[0]
      if (!choice) throw new Error('rollout-select: generator returned no choices')
      const reasoning = choice.message?.reasoning_content ?? ''
      const content = choice.message?.content ?? ''
      const text =
        reasoning && content ? `${reasoning}\n\n--- final answer ---\n\n${content}` : reasoning || content
      return { text, reasoning, content, usage: json.usage ?? null }
    },
  }
}

// ---------------------------------------------------------------------------
// Rollout generator — the "rollout" half of rollout-select. The reference
// pipeline (llm-as-a-verifier) samples N rollouts from the generator/policy
// model IN PARALLEL (temperature 1.0, diverse, each an independent inference)
// and THEN the verifier ranks them. resolveCandidates() performs that sampling
// whenever the caller does not hand over explicit candidate trajectories.
// ---------------------------------------------------------------------------

export function rolloutPrompt(problem) {
  return [
    'You are a helpful AI assistant solving a task.',
    'Think through it step by step and give a complete final answer.',
    'Be rigorous: show your work, then state the answer clearly.',
    '',
    `Task:\n${problem}`,
  ].join('\n')
}

export async function generateRollouts(api, problem, n, model, signal) {
  const count = Math.max(1, Math.min(n || 1, 64))
  const prompt = rolloutPrompt(problem)
  // concurrency = count → all `count` completions are in flight at once (parallel).
  return poolMap(
    Array.from({ length: count }, (_, i) => i),
    async () => (await api.generateRollout(prompt, model, signal)).text,
    count,
  )
}

/**
 * Resolve the candidate list for a best-of-N selection. If the caller supplied
 * explicit candidates, use them verbatim; otherwise sample `nRollouts` rollouts
 * from the generator model in parallel (temperature 1.0).
 * Returns `{ rollouts, generated }`.
 */
export async function resolveCandidates(api, opts) {
  const { problem, candidates, nRollouts = 3, generatorModel, signal } = opts
  if (Array.isArray(candidates) && candidates.length > 0) {
    return { rollouts: candidates, generated: false }
  }
  const rollouts = await generateRollouts(api, problem, nRollouts, generatorModel, signal)
  return { rollouts, generated: true }
}

// ---------------------------------------------------------------------------
// Probabilistic Pivot Tournament (port of llm_verifier/pivot_tournament.py).
// ---------------------------------------------------------------------------

function ringCycle(n, rng) {
  if (n <= 1) return []
  const perm = Array.from({ length: n }, (_, i) => i)
  shuffleInPlace(perm, rng)
  return perm.map((_, t) => [perm[t], perm[(t + 1) % n]])
}

/**
 * 完整两两锦标赛（round-robin）：生成 C(n,2) 个无向对，全部一次性并行评分。
 * 用 (i+j) 奇偶性决定谁占 A 槽，使每个候选的 A/B 槽位尽量均衡——奇数 n 时每个
 * 候选恰好 2 次 A / 2 次 B，消除 judge 对轨迹槽位（A/B）的位置偏好偏差。
 * 小 n（≤~6）下完整锦标赛 + Bradley-Terry 是最大似然排序，优于 ring→pivot 近似：
 * 比对数几乎相同（n=5 时 10 vs 9），却少一个串行屏障，且无 pivot 对被重复加权。
 */
function roundRobinPairs(n) {
  const pairs = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairs.push((i + j) % 2 === 0 ? [i, j] : [j, i])
    }
  }
  return pairs
}

function bradleyTerry(ra, rb) {
  return 1 / (1 + Math.exp(-(ra - rb)))
}

function selectPivots(w, c, k) {
  const n = w.length
  const kk = Math.min(k, n)
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const pa = c[a] ? w[a] / c[a] : 0
    const pb = c[b] ? w[b] / c[b] : 0
    return pb - pa || a - b
  })
  return order.slice(0, kk)
}

function pivotRoundPairs(n, pivots) {
  const pivotSet = new Set(pivots)
  const nonPivots = []
  for (let i = 0; i < n; i++) if (!pivotSet.has(i)) nonPivots.push(i)
  const pairs = []
  for (const i of nonPivots) for (const p of pivots) pairs.push([i, p])
  const sorted = [...pivots].sort((a, b) => a - b)
  for (let a = 0; a < sorted.length; a++) {
    for (let b = a + 1; b < sorted.length; b++) pairs.push([sorted[a], sorted[b]])
  }
  return pairs
}

// ---------------------------------------------------------------------------
// Criteria normalization.
// ---------------------------------------------------------------------------

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'criterion'
  )
}

const DEFAULT_CRITERIA = [
  {
    id: 'overall_solution_quality',
    name: 'overall_solution_quality',
    description: 'Which trajectory more likely solves the task correctly and completely?',
  },
]

/**
 * Accepts the reference repo's criteria forms: an array of strings, an array
 * of `{id, name, description}` dicts, or a `{name: description}` mapping.
 */
export function normalizeCriteria(criteria) {
  const out = []
  const push = (id, name, description) => {
    out.push({
      id: id || slugify(name || description || ''),
      name: name || id || 'criterion',
      description: description || name || '',
    })
  }
  if (criteria == null) return DEFAULT_CRITERIA
  if (Array.isArray(criteria)) {
    for (const c of criteria) {
      if (typeof c === 'string') push('', c, c)
      else if (c && typeof c === 'object') push(c.id, c.name, c.description)
    }
  } else if (criteria && typeof criteria === 'object') {
    for (const [name, description] of Object.entries(criteria)) {
      if (typeof description === 'string') push('', name, description)
    }
  }
  return out.length > 0 ? out : DEFAULT_CRITERIA
}

// ---------------------------------------------------------------------------
// Concurrency helper: bounded worker pool over an item list.
// ---------------------------------------------------------------------------

async function poolMap(items, worker, concurrency) {
  const results = new Array(items.length)
  let idx = 0
  const c = Math.max(1, Math.min(concurrency || 1, items.length))
  const runners = Array.from({ length: c }, async () => {
    while (true) {
      const i = idx++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 保留开头的截断（judge 的分析文字在开头，评分标签在结尾）。评分已单独抽取为
 * scoreA/scoreB，落盘记录里的 response 仅用于展示，截断只丢尾部不丢分析。
 */
function headSlice(text, max) {
  const s = String(text ?? '')
  if (s.length <= max) return { text: s, truncated: false }
  return { text: s.slice(0, max), truncated: true }
}

/** 把一次 judge 直连调用的 raw usage 归一为 { inputTokens, outputTokens }。 */
function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return { inputTokens: 0, outputTokens: 0 }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  if ('prompt_tokens' in usage || 'completion_tokens' in usage) {
    return { inputTokens: num(usage.prompt_tokens), outputTokens: num(usage.completion_tokens) }
  }
  return { inputTokens: num(usage.input) + num(usage.cacheRead), outputTokens: num(usage.output) }
}

/** 单次 judge 调用的展示记录（落盘进 judgeCalls，供客户端逐请求展示）。 */
function judgeCallRecord(rec, response, truncated, error, scoreA, scoreB, ttftMs, wallMs, inputTokens, outputTokens) {
  return {
    a: rec.a,
    b: rec.b,
    rep: rec.rep,
    swap: rec.swap,
    critId: rec.critId,
    critName: rec.critName,
    critDescription: rec.critDescription,
    response,
    responseTruncated: truncated,
    error,
    scoreA,
    scoreB,
    ttftMs,
    wallMs,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Public entry points (mirror llm_verifier.select / llm_verifier.compare).
// ---------------------------------------------------------------------------

/**
 * Best-of-N selection with full tournament detail. Returns the same selection
 * fields as {@link selectBest} (index/best/scores/ranking/n_comparisons/
 * criteria) PLUS: raw Bradley-Terry soft-win / compare / loss counts, the
 * pivot set, the ring and pivot-round schedules, the per-phase pairwise
 * comparisons (with per-criterion-aggregated rewards and Bradley-Terry
 * probabilities), a pairwise matrix over the played directed pairs, and
 * per-criterion per-candidate scores. Reads everything from the same scoring
 * cache — no extra verifier calls beyond the tournament itself.
 */
export async function selectBestDetailed(api, opts) {
  const {
    problem,
    candidates,
    criteria,
    nEvaluations = 4,
    pivots = 2,
    judgeMode = 'roundrobin',
    seed = 0,
    model,
    groundTruthNote = '',
    scaleDescription = SCALE_DESCRIPTION,
    maxWorkers = 50,
    timeoutMs = 30000,
    signal,
    sessionId,
  } = opts
  const n = candidates.length
  const crits = normalizeCriteria(criteria)
  const criteriaIds = crits.map((c) => c.id)
  if (n === 0) throw new Error('rollout-select: need at least one candidate')
  if (n === 1) {
    return {
      index: 0,
      best: candidates[0],
      scores: [1],
      ranking: [0],
      n_comparisons: 0,
      criteria: criteriaIds,
      win_counts: [0],
      losses: [0],
      compare_counts: [0],
      pivots: [0],
      ring: [],
      pivot_pairs: [],
      comparisons: [],
      pairwise: [],
      per_criterion: crits.map((crit) => ({ id: crit.id, name: crit.name, description: crit.description, scores: [1] })),
      judgeCalls: [],
      judgeUsage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
      judgeTiming: { ringMs: 0, pivotMs: 0, totalJudgeMs: 0, calls: 0, callMs: [], callTtftMs: [] },
    }
  }

  const cache = new Map()
  const cacheKey = (critId, a, b, rep) => `${critId}|${a},${b}|${rep}`
  const judgeUsage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
  const callMs = [] // per-judge-call wall-clock latency (for latency diagnosis)
  const callTtftMs = [] // per-judge-call first-token latency (for 首 token 时延)
  const judgeCalls = [] // per-judge-call request/response 明细（供客户端逐请求展示）

  async function scoreDirectedPairs(pairs) {
    const jobs = []
    for (const [a, b] of pairs) {
      for (const crit of crits) {
        for (let rep = 0; rep < nEvaluations; rep++) jobs.push({ a, b, crit, rep })
      }
    }
    await poolMap(
      jobs,
      async ({ a, b, crit, rep }) => {
        const key = cacheKey(crit.id, a, b, rep)
        if (cache.has(key)) return
        const swap = rep % 2 === 1 // odd reps swap prompt slots to cancel slot bias
        let ta = candidates[a]
        let tb = candidates[b]
        if (swap) [ta, tb] = [tb, ta]
        const prompt = buildPrompt(problem, ta, tb, crit, groundTruthNote, scaleDescription)
        const tCall = Date.now()
        const rec = {
          a,
          b,
          rep,
          swap,
          critId: crit.id,
          critName: crit.name,
          critDescription: crit.description,
        }
        try {
          const { text, tokens, positionLogprobs, usage, ttftMs } = await api.call(prompt, model, signal, sessionId, timeoutMs)
          addUsage(judgeUsage, usage)
          const ut = usageTokens(usage)
          let ra = extractScore(text, tokens, positionLogprobs, '<score_A>')
          let rb = extractScore(text, tokens, positionLogprobs, '<score_B>')
          if (swap) [ra, rb] = [rb, ra] // record back in candidate order
          cache.set(key, { score_A: ra, score_B: rb })
          callTtftMs.push(ttftMs ?? null)
          const sliced = headSlice(text, 4000)
          judgeCalls.push(judgeCallRecord(
            rec, sliced.text, sliced.truncated, '',
            Number(ra.toFixed(4)), Number(rb.toFixed(4)), ttftMs ?? null, Date.now() - tCall,
            ut.inputTokens, ut.outputTokens,
          ))
        } catch (error) {
          // on_error = 'random': 超时/失败的这次对比随机判一方胜（1/0 或 0/1），而不是
          // 静默 0.5/0.5 平局——既避免「全平局 → winner 退化成掷硬币」，也明确表达
          // 「judge 没给出有效评分时，本轮由随机兜底」。
          const winA = Math.random() < 0.5
          cache.set(key, { score_A: winA ? 1 : 0, score_B: winA ? 0 : 1 })
          callTtftMs.push(null)
          judgeCalls.push(judgeCallRecord(
            rec, '', false, String(error?.message ?? error ?? 'judge failed'),
            winA ? 1 : 0, winA ? 0 : 1, null, Date.now() - tCall, 0, 0,
          ))
        }
        callMs.push(Date.now() - tCall)
      },
      maxWorkers,
    )
  }

  function directedReward(a, b) {
    let sa = 0
    let sb = 0
    let cnt = 0
    for (const crit of crits) {
      for (let rep = 0; rep < nEvaluations; rep++) {
        const entry = cache.get(cacheKey(crit.id, a, b, rep)) ?? { score_A: 0.5, score_B: 0.5 }
        sa += entry.score_A
        sb += entry.score_B
        cnt += 1
      }
    }
    return cnt ? [sa / cnt, sb / cnt] : [0.5, 0.5]
  }

  function criterionReward(ci, a, b) {
    let sa = 0
    let sb = 0
    let cnt = 0
    for (let rep = 0; rep < nEvaluations; rep++) {
      const entry = cache.get(cacheKey(crits[ci].id, a, b, rep)) ?? { score_A: 0.5, score_B: 0.5 }
      sa += entry.score_A
      sb += entry.score_B
      cnt += 1
    }
    return cnt ? [sa / cnt, sb / cnt] : [0.5, 0.5]
  }

  function accumulate(pairs, w, c) {
    for (const [a, b] of pairs) {
      const [ra, rb] = directedReward(a, b)
      const p = bradleyTerry(ra, rb)
      w[a] += p
      c[a] += 1
      w[b] += 1 - p
      c[b] += 1
    }
  }

  const rng = mulberry32(seed)

  // 锦标赛调度：
  //  - roundrobin（默认）：一次性生成 C(n,2) 个无向对并并行评分，单阶段完整锦标赛。
  //    小 n（≤~6）下与 PPT 的 ring→pivot 比对数几乎相同（n=5 时 10 vs 9），但少一个
  //    串行屏障（pivot 依赖 ring 的 selectPivots），且完整锦标赛 + Bradley-Terry 是
  //    最大似然排序，还避免了 pivot 对在 ring 里重复被 accumulate 双倍加权的问题。
  //  - ppt：ring 循环 → 选 pivot → pivot 轮，用于大 n 时把 O(N²) 降到 O(Nk)。
  const useRoundRobin = (judgeMode || 'roundrobin') === 'roundrobin'
  let ring = []
  let prPairs = []
  let pivotSet = []
  let ringMs = 0
  let pivotMs = 0

  if (useRoundRobin) {
    ring = roundRobinPairs(n)
    const t0 = Date.now()
    await scoreDirectedPairs(ring)
    ringMs = Date.now() - t0
  } else {
    ring = ringCycle(n, rng)
    // Phase A: ring pass (slot bias cancels around the cycle).
    const tA = Date.now()
    await scoreDirectedPairs(ring)
    ringMs = Date.now() - tA
    const wA = new Array(n).fill(0)
    const cA = new Array(n).fill(0)
    accumulate(ring, wA, cA)
    pivotSet = selectPivots(wA, cA, pivots)
    prPairs = pivotRoundPairs(n, pivotSet)
    // Phase B: score the pivot rounds, then aggregate everything.
    const tB = Date.now()
    await scoreDirectedPairs(prPairs)
    pivotMs = Date.now() - tB
  }

  const allPairs = useRoundRobin ? ring : [...ring, ...prPairs]
  const w = new Array(n).fill(0)
  const c = new Array(n).fill(0)
  accumulate(allPairs, w, c)

  const meanPref = w.map((wi, i) => (c[i] ? wi / c[i] : 0))
  let best = 0
  for (let i = 1; i < n; i++) {
    if (meanPref[i] > meanPref[best]) best = i
  }
  const ranking = meanPref
    .map((_, i) => i)
    .sort((a, b) => meanPref[b] - meanPref[a] || a - b)

  // ---- Detail collection (read from the same cache; no extra verifier calls).
  const comparisons = []
  const addPhase = (pairs, phase) => {
    for (const [a, b] of pairs) {
      const [ra, rb] = directedReward(a, b)
      const p = bradleyTerry(ra, rb)
      comparisons.push({ a, b, phase, ra, rb, p_bt: p, win_a: p, win_b: 1 - p })
    }
  }
  if (useRoundRobin) addPhase(ring, 'roundrobin')
  else {
    addPhase(ring, 'ring')
    addPhase(prPairs, 'pivot')
  }

  const played = new Set()
  for (const [a, b] of allPairs) played.add(`${a},${b}`)
  const pairwise = []
  for (const key of played) {
    const [a, b] = key.split(',').map(Number)
    const [ra, rb] = directedReward(a, b)
    pairwise.push({ a, b, ra, rb, p_bt: bradleyTerry(ra, rb) })
  }
  pairwise.sort((x, y) => x.a - y.a || x.b - y.b)

  const perCriterion = crits.map((crit, ci) => {
    const cw = new Array(n).fill(0)
    const cc = new Array(n).fill(0)
    for (const [a, b] of allPairs) {
      const [ra, rb] = criterionReward(ci, a, b)
      const p = bradleyTerry(ra, rb)
      cw[a] += p
      cc[a] += 1
      cw[b] += 1 - p
      cc[b] += 1
    }
    return {
      id: crit.id,
      name: crit.name,
      description: crit.description,
      scores: cw.map((wi, i) => (cc[i] ? wi / cc[i] : 0)),
    }
  })

  // 按 (标准, A, B, rep) 排序，展示顺序稳定，不受 poolMap 并发完成顺序影响。
  judgeCalls.sort((x, y) =>
    String(x.critId).localeCompare(String(y.critId)) || x.a - y.a || x.b - y.b || x.rep - y.rep)

  return {
    index: best,
    best: candidates[best],
    scores: meanPref,
    ranking,
    n_comparisons: allPairs.length,
    criteria: criteriaIds,
    win_counts: w,
    losses: w.map((wi, i) => c[i] - wi),
    compare_counts: c,
    pivots: pivotSet,
    ring,
    pivot_pairs: prPairs,
    comparisons,
    pairwise,
    per_criterion: perCriterion,
    judgeCalls,
    judgeUsage,
    judgeTiming: {
      ringMs,
      pivotMs,
      totalJudgeMs: ringMs + pivotMs,
      calls: callMs.length,
      callMs,
      callTtftMs,
    },
  }
}

/**
 * Best-of-N selection (summary). Returns the winning index, the winning
 * trajectory, per-candidate mean preference (w_i / c_i), the best-first
 * ranking, the number of directed comparisons run, and the criterion ids used.
 * Delegates to {@link selectBestDetailed} so both share one tournament and one
 * RNG stream (identical inputs → identical winner and scores).
 */
export async function selectBest(api, opts) {
  const d = await selectBestDetailed(api, opts)
  return {
    index: d.index,
    best: d.best,
    scores: d.scores,
    ranking: d.ranking,
    n_comparisons: d.n_comparisons,
    criteria: d.criteria,
    per_criterion: d.per_criterion,
    judgeCalls: d.judgeCalls,
    judgeUsage: d.judgeUsage,
    judgeTiming: d.judgeTiming,
  }
}

/**
 * Fine-grained rewards (R_A, R_B) in [0, 1] for one directed comparison.
 * `traceA` occupies slot A, `traceB` slot B. A single directed call does NOT
 * cancel slot bias the way `selectBest`'s ring pass does.
 */
export async function comparePair(api, opts) {
  const {
    problem,
    traceA,
    traceB,
    criteria,
    nEvaluations = 1,
    model,
    groundTruthNote = '',
    scaleDescription = SCALE_DESCRIPTION,
    maxWorkers = 8,
    signal,
    sessionId,
  } = opts
  const crits = normalizeCriteria(criteria)
  const jobs = []
  for (const crit of crits) {
    for (let rep = 0; rep < nEvaluations; rep++) jobs.push(crit)
  }
  const results = await poolMap(
    jobs,
    async (crit) => {
      const prompt = buildPrompt(problem, traceA, traceB, crit, groundTruthNote, scaleDescription)
      const { text, tokens, positionLogprobs } = await api.call(prompt, model, signal, sessionId)
      return [
        extractScore(text, tokens, positionLogprobs, '<score_A>'),
        extractScore(text, tokens, positionLogprobs, '<score_B>'),
      ]
    },
    maxWorkers,
  )
  const ra = results.reduce((s, r) => s + r[0], 0) / results.length
  const rb = results.reduce((s, r) => s + r[1], 0) / results.length
  return { score_a: ra, score_b: rb }
}
