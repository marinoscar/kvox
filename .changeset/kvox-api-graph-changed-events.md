---
"@marinoscar/kvox-api": patch
---

Publish `graph.changed` after a proposal commit (`commit`, or `import` for an RDF import proposal), a revert, a manual merge and a merge reversal, once per action and only after the transaction commits, so the graph layout re-lays after material changes (#591).
