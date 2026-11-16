// Test-only fixture for real-host.test.mjs: records every "dsh-alignment/changed" Cordis event and serves them at
// GET /changed-probe (no auth; only ever mounted in the test's temp profile).
export const name = "dsh-alignment-changed-probe";
export const inject = ["webServer"];
export function apply(ctx) {
  const seen = [];
  ctx.on("dsh-alignment/changed", (payload) => { seen.push({ at: Date.now(), payload: structuredClone(payload) }); });
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/changed-probe", handler: (req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(seen));
  } }), "dsh-alignment-changed-probe: /changed-probe");
}
