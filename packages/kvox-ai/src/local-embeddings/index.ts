/**
 * `@marinoscar/kvox-ai/local-embeddings`: the on-device embedding model
 * (`KVOX_LOCAL_EMBEDDING`, bge-small-en-v1.5 int8) for KVox Desktop (#660).
 *
 * @remarks
 * Not re-exported by the package root. The embedder lazily loads the optional
 * peers `onnxruntime-web` and `@huggingface/tokenizers`. It BLOCKS the event
 * loop: run it off the event loop (see `local-embedder.ts`).
 *
 * @packageDocumentation
 */
export * from './local-embedder.js';
export * from './local-embedding-files.js';
export * from './local-embedding-model.js';
export * from './local-embedding-runtime.js';
