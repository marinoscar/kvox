---
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-db": minor
"@marinoscar/kvox-eval": minor
"@marinoscar/kvox-web": minor
---

Ontology 1.3.0, step 3 (#664, epic #661). `@marinoscar/kvox-contract/ontology`: the `Risk` item type (work, `itemKind: 'risk'`, statuses `open | mitigated | closed | superseded`, subjects Person, Organization, Project, Product or Topic, attributes `severity`, `riskKind`, `mitigation`), `ABOUT` starts at a Risk and `SUPERSEDES` allows Risk to Risk; the wire schemas learn the `risk` item kind, the `Risk` proposal group and the brief's optional `openRisks` section. `@marinoscar/kvox-db`: migration `add_kg_item_kind_risk` adds `risk` to the `kg_item_kind` enum (additive; no row changes). `@marinoscar/kvox-api`: the extraction prompt, output schema and RDF exports offer Risk, `GraphWriteService` writes it with evidence, the Ask toolset gains the read-only `list_risks` tool (subject, status, severity; highest severity first), and the entity brief of a Project, Product or Organization gains an "Open risks" section (cited, never a model call, omitted when empty or when the work domain is off). `@marinoscar/kvox-eval`: 18 gold Risk items (m50-m55). `@marinoscar/kvox-web`: the brief card shows "Open risks" when the API sends it, and the review, timeline and add-to-graph surfaces handle the Risk kind.
