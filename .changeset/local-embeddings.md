---
'@marinoscar/kvox-ai': minor
---

New entry point `@marinoscar/kvox-ai/local-embeddings`: the on-device embedding model for `KVOX_LOCAL_EMBEDDING` (bge-small-en-v1.5, int8, MIT). `downloadLocalEmbeddingModel`, `localEmbeddingModelStatus` and `removeLocalEmbeddingModel` install the three pinned files (revision-pinned Hugging Face URLs, exact size and SHA-256, https and exact-host allowlist checked on every redirect hop); `createLocalEmbedder` runs the model on `onnxruntime-web` and `@huggingface/tokenizers` (optional peers, loaded lazily; it blocks the event loop, so run it off the event loop); `createLocalEmbeddingRuntime` wraps a host's embed transport as a `KvoxAiRuntime`. The verified download that `prepareCopilotRuntime` used is now shared (`download` slice) with identical behaviour.
