---
'@marinoscar/kvox-api': minor
---

Graph extraction now reads a long note in chunks. A note body above about 3,000 tokens is split on heading, paragraph, table-row and list-item boundaries, each chunk is one structured call inside the same extraction job (sequential, capped per chunk, resumable after the last finished chunk), and the rows are merged: entities deduped by type, label and aliases, citations unioned, relations and items re-pointed. Citations carry absolute offsets into the note. The estimate reports one request per chunk, and a long note is no longer refused for not fitting in one prompt. The prompt role line now asks for complete coverage of everything the text supports with a citation. The job's maximum runtime is 96 minutes (at most 12 chunks).
