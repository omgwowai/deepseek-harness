// Oh My Pi extension loaded by the DSH ACP route (`omp acp -e <this file>`, see configure.mjs).
// A DSH branch of an ACP-bound session hands its lineage over as DSH_ACP_LINK_HEADERS (JSON). Oh My Pi has
// no per-request header hook, so — like TokenRouter's own omp extension — the headers are added in the
// process fetch, only on requests to the TokenRouter origin and never over a header the caller already set.
// Without the variable (every non-branch session, and the user's own `omp`) the extension does nothing.
const links = (() => { try { return JSON.parse(process.env.DSH_ACP_LINK_HEADERS ?? "{}"); } catch { return {}; } })();
const origin = (() => { try { return new URL(process.env.TOKENROUTER_BASE_URL ?? "https://tokenrouterv2.omgwow.tech").origin; } catch { return null; } })();

export default function dshAcpLinkHeaders() {
  const names = Object.keys(links);
  if (!names.length || origin === null || globalThis.fetch?.dshAcpLinks) return;
  const previous = globalThis.fetch;
  const patched = (input, init) => {
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.origin !== origin || url.pathname.startsWith("/v1/otel")) return previous(input, init);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      for (const name of names) if (!headers.has(name)) headers.set(name, String(links[name]));
      return input instanceof Request && init === undefined ? previous(new Request(input, { headers })) : previous(input, { ...init, headers });
    } catch {
      return previous(input, init);
    }
  };
  patched.dshAcpLinks = true;
  globalThis.fetch = patched;
}
