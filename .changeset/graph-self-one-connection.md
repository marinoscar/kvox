---
'@marinoscar/kvox-api': patch
---

Graph neighbourhood, expand and path reads no longer hang on a host whose database serves a single connection. The owner's own Person (#778) is now looked up before the read transaction opens, instead of through the root client inside it (#805).
