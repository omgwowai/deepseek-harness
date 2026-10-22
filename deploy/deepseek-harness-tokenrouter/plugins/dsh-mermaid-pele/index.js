/**
 * Host loader entry for `@local/dsh-mermaid-pele`.
 *
 * All behaviour lives in the browser half (`client.js`); this entry only exists
 * so the bundle's patch can insert a normal Loader row. The Loader needs an
 * `apply` export — an empty module makes the entry report "failed to import".
 */
export const name = "@local/dsh-mermaid-pele";

/** No host-side behaviour. */
export function apply() {}
