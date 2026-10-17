---
"@marinoscar/kvox-web": patch
---

Rewrite the generated TSDoc of the `graph` slice (`@marinoscar/kvox-web/graph/headless` and `/graph/ui`) into specific descriptions: the wire types of the knowledge-graph client now say what each field means and when it is absent or `null`, the contract aliases name the values they carry, and the hooks, utilities, pages and component props describe what they do. Documentation only; no runtime code, type or export changes.
