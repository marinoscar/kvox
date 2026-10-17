---
"@marinoscar/kvox-api": patch
---

Declare `@fastify/multipart` as a host plugin of the `notes` and `graph-rdf` slices (`$hostPlugins` in `kvox-slice-peers.json`, enforced by `check-slice-peers` rule 8), and answer a clear 500 from the document and RDF upload routes when the host has not registered it.
