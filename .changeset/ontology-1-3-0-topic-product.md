---
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-api": minor
---

Ontology 1.3.0, step 1 (#662, epic #661). `@marinoscar/kvox-contract/ontology`: `Topic` (core, `skos:Concept`) and `Product` (work, `schema:Product`) entity types, the `BROADER` relation (Topic to Topic, `skos:broader`), `DISCUSSED` now reaches Project, Topic, Product and Organization, `PART_OF` gains Topic to Project, and Commitment and Decision subjects may be a Product or a Topic. All keys are additive and recorded in `shipped-keys.ts`; no migration. `@marinoscar/kvox-api`: the extraction prompt, output schema and RDF (OWL and SHACL) exports pick the new types up from the registry.
