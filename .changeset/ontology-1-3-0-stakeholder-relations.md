---
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-api": minor
---

Ontology 1.3.0, step 2 (#663, epic #661). `@marinoscar/kvox-contract/ontology`: the work domain gains the stakeholder and market relations `INVOLVED_IN` (Person to Project, `role` and optional `stance`), `USES` (Organization or Project to Product, `stage`; a stage change closes the earlier row), `OFFERED_BY` (Product to Organization), `CUSTOMER_OF`, `PARTNER_OF` and `COMPETITOR_OF` (Organization to Organization, the last two symmetric), `CONCERNS` (Project to Product or Topic) and `KNOWS_ABOUT` (Person to Topic or Product, `level`). All keys are additive and recorded in `shipped-keys.ts`; no migration. `@marinoscar/kvox-api`: the extraction prompt, output schema and RDF (OWL and SHACL) exports pick the new relations up from the registry.
