---
"@marinoscar/kvox-db": minor
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-web": minor
---

Add the `kg_synonyms` table (`KgSynonym`): the owner's personal synonym dictionary for the knowledge graph, with a GIN index on `normalized` and a cardinality CHECK.

Add the personal synonym dictionary (issue #767): `GET/POST /graph/synonyms`, `PATCH/DELETE /graph/synonyms/{id}` (`GraphSynonymsController`, `SynonymsService`, contract `synonyms.ts`). Entity resolution matches a mention against every term of a synonym group that contains one of its names, the possible-duplicates list proposes same-type entities whose names share a group (new reason `synonym`, score 0.9) and entity search finds an entity under any name of a matching group.

Add the Synonyms page (`/graph/synonyms`, `GraphSynonymsPage`) with the `listSynonyms`/`createSynonym`/`updateSynonym`/`deleteSynonym` client and the `useGraphSynonyms` hook, "Synonyms" links on Possible duplicates and the Knowledge index menu, and an "Also add these names to my synonyms" option in the merge dialog.
