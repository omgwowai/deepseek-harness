// Browser half of Agent Fleet (loaded by DSH's module loader; the server half is index.js).
//   · "Agent Fleet" in the sidebar → a full-height page that iframes the hub's panel
//   · "Agent Fleet" tab beside Chat / Trajectory of a session → the same panel focused on that session's family
// The iframe URL comes from the host's `agent-fleet/panel-url` RPC (a one-time `#nonce=` in the fragment, never the token).
window.__ModuleLoader__.load({
  id: "@local/dsh-agent-fleet",
  factory: require => {
    const { createElement: h, useEffect, useLayoutEffect, useRef, useState } = require("react");
    const id = "agent-fleet";
    const OPEN_IN_BROWSER = "agent-fleet/open-in-browser";

    const callPanelUrl = (ctx, sessionId, signal) => ctx.connection.rpc.call("/api", "agent-fleet/panel-url", sessionId === undefined ? {} : { sessionId }, signal)
      .then(result => { if (!result.ok) throw new Error(result.error.message); return result.value; });

    function FleetIcon({ size }) {
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" },
        h("circle", { cx: 12, cy: 5, r: 2.2 }), h("circle", { cx: 5, cy: 19, r: 2.2 }), h("circle", { cx: 19, cy: 19, r: 2.2 }),
        h("path", { d: "M12 7.2v4.3M12 11.5 6.4 16.9M12 11.5l5.6 5.4" }));
    }

    // The panel iframe. The panel cannot open a browser window from inside its sandbox, so it posts
    // {type: "agent-fleet/open-in-browser", url} to this page; only a message from this iframe, from the panel's own
    // origin, naming a URL on that origin is acted on (in the desktop shell window.open turns http(s) URLs into the
    // OS default browser).
    function Body({ sessionId, loadPanel, page }) {
      const [entry, setEntry] = useState(null), [error, setError] = useState("");
      const load = useRef(loadPanel), frame = useRef(null);
      load.current = loadPanel;
      useEffect(() => {
        const controller = new AbortController();
        setEntry(null); setError("");
        load.current(controller.signal).then(result => { if (!controller.signal.aborted) setEntry(result); }, failure => { if (!controller.signal.aborted) setError(String(failure?.message ?? failure)); });
        return () => controller.abort();
      }, [sessionId]);
      useEffect(() => {
        if (!entry) return undefined;
        let panel;
        try { panel = new URL(entry.url, window.location.href); } catch { return undefined; }
        const onMessage = event => {
          if (event.origin !== panel.origin || event.source !== frame.current?.contentWindow) return;
          const data = event.data;
          if (!data || data.type !== OPEN_IN_BROWSER || typeof data.url !== "string") return;
          let url;
          try { url = new URL(data.url, panel); } catch { return; }
          if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== panel.origin) return;
          window.open(url.href, "_blank", "noopener,noreferrer");
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, [entry?.url]);
      const box = page ? { flex: "1 1 0%", width: "100%", height: "100%" } : { height: "100%" };
      return h("div", { style: { ...box, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }, "data-agent-fleet-session": sessionId },
        error ? h("p", { role: "alert", style: { padding: 12 } }, error)
          : entry ? h("iframe", { ref: frame, title: "Agent Fleet", src: entry.url, sandbox: "allow-scripts allow-same-origin allow-forms", referrerPolicy: "no-referrer", style: { border: 0, width: "100%", flex: 1, minHeight: 0, background: "#101114" } })
            : h("p", { style: { padding: 12 } }, "正在读取 Agent Fleet…"));
    }

    function FleetPage({ loadPanel }) { return h(Body, { sessionId: undefined, loadPanel, page: true }); }

    // The Agent Fleet tab owns the conversation's bottom area, so while it is the active view the resident
    // composer must not render. `conversation.composer` is the chain slot for such takeovers; the view component
    // mounts only while its tab is selected, so a layout effect registers an emptying takeover for exactly this
    // session and drops it again on unmount. Unanswered approvals and questions keep the seat. The priority
    // differs from Agent DAG's (-1000) so the two tabs' gates can never claim the same chain position.
    function createFleetTab({ ctx }) {
      const HIDDEN = "agent-fleet/hidden-composer";
      function HiddenComposer() { return null; }
      return function FleetTab({ sessionId, loadPanel }) {
        useLayoutEffect(() => {
          if (sessionId === undefined) return undefined;
          return ctx.slots.inject("conversation.composer", () => ctx.slots.register({
            name: "conversation.composer", priority: -1001,
            select: owner => owner.sessionId === sessionId && owner.pendingInteraction === undefined ? HIDDEN : null
          }, HiddenComposer));
        }, [sessionId]);
        return h(Body, { sessionId, loadPanel });
      };
    }

    return {
      inject: ["connection", "slots"],
      apply(ctx) {
        const FleetTab = createFleetTab({ ctx });
        ctx.effect(() => ctx.slots.inject("conversation.view", () => ctx.slots.register({
          name: "conversation.view", id, order: 35, label: () => "Agent Fleet",
          inject: sessionId => ({ loadPanel: signal => callPanelUrl(ctx, sessionId, signal) })
        }, FleetTab)));
        // The `main` page key must equal the sidebar entry id: the sidebar selects the page by it.
        ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register({
          name: "main", key: id,
          inject: () => ({ loadPanel: signal => callPanelUrl(ctx, undefined, signal) })
        }, FleetPage)));
        ctx.effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
          name: "sidebar.panellist", id, order: 20, label: () => "Agent Fleet"
        }, FleetIcon)));
      }
    };
  }
});
