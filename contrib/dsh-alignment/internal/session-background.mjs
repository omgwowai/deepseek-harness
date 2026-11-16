/**
 * What a session still has running in the background while its own turn is over (2026-10-24): a session that
 * dispatched subagents and ended its turn to wait for them is idle as an agent, yet not stopped. The alignment page
 * (dsh-alignment liveStates) and dsh-fm (the "已停没有下一步" section) must not call it stopped.
 *
 * Source: the host's own workspace/session-activity waterfall (the archive admission's list): dsh-subagent answers
 * "subagent" (running subagent descendants at any depth), dsh-jobs answers "job" (running / stopping jobs the session
 * owns). "turn" (dsh-agent) and "schedule" (dsh-schedule: reminders are not work in flight) are ignored here.
 * A subagent's own jobs are not listed, but they only exist while that subagent is loaded and its settlement
 * cancels them (dsh-safe-change pitfall 2026-10-18), so a running subagent already covers them.
 *
 * Returns "subagent" | "job" | null. Fails loud when the waterfall is missing or answers in another shape.
 */
export async function backgroundOf(waterfall, sid) {
  const kinds = new Set((await activityOf(waterfall, sid)).map((a) => a?.kind));
  if (kinds.has("subagent")) return "subagent";
  if (kinds.has("job")) return "job";
  return null;
}

/**
 * The same list by id (2026-10-24, the alignment page's 已用 counts the time subagents and jobs ran):
 * {subagent: Set<session id> of the running subagent descendants, job: Set<job id> of the session's running / stopping
 * jobs}. Items are {id, label?}; another shape fails loud.
 */
export async function runningOf(waterfall, sid) {
  const out = { subagent: new Set(), job: new Set() };
  for (const a of await activityOf(waterfall, sid)) {
    if (a?.kind !== "subagent" && a?.kind !== "job") continue;
    if (!Array.isArray(a.items)) throw new Error("session-background: workspace/session-activity " + a.kind + " entry without items[] (DSH API changed)");
    for (const item of a.items) {
      if (typeof item?.id !== "string") throw new Error("session-background: workspace/session-activity " + a.kind + " item without a string id (DSH API changed)");
      out[a.kind].add(item.id);
    }
  }
  return out;
}

/**
 * The same list as items (2026-10-24, the alignment page shows what runs): {subagent: [{id, label?}], job: [{id, label?}]}
 * in the host's order (subagents: breadth-first from the session; jobs: the registry's list order). label is the
 * subagent's creation label (the subagent tool's description, a workflow agent's label) or the job's label; the host
 * leaves it out when it has none (a subagent whose descriptor cannot be read). Another shape fails loud.
 */
export async function itemsOf(waterfall, sid) {
  const out = { subagent: [], job: [] };
  for (const a of await activityOf(waterfall, sid)) {
    if (a?.kind !== "subagent" && a?.kind !== "job") continue;
    if (!Array.isArray(a.items)) throw new Error("session-background: workspace/session-activity " + a.kind + " entry without items[] (DSH API changed)");
    for (const item of a.items) {
      if (typeof item?.id !== "string") throw new Error("session-background: workspace/session-activity " + a.kind + " item without a string id (DSH API changed)");
      if (item.label !== undefined && typeof item.label !== "string") throw new Error("session-background: workspace/session-activity " + a.kind + " item label is " + typeof item.label + " (DSH API changed)");
      out[a.kind].push(item.label === undefined ? { id: item.id } : { id: item.id, label: item.label });
    }
  }
  return out;
}

async function activityOf(waterfall, sid) {
  if (typeof waterfall !== "function") throw new Error("session-background: ctx.waterfall is missing (DSH API changed)");
  const activity = await waterfall("workspace/session-activity", { sessionId: sid }, () => Promise.resolve([]));
  if (!Array.isArray(activity)) throw new Error("session-background: workspace/session-activity gave " + typeof activity + ", not an array (DSH API changed)");
  return activity;
}
