# local-embeddings

`@marinoscar/kvox-ai/local-embeddings`: the on-device embedding model behind `KVOX_LOCAL_EMBEDDING`, so KVox Desktop can index and search with no key and no network after one download (issue #660).

## Purpose and scope

Status: issue #660.

- **Model.** bge-small-en-v1.5 (BAAI), the int8-QUANTIZED ONNX build converted by Xenova. 384-wide, 512-token input, CLS pooling, L2-normalised. License: MIT. About 34.7 MB in three files: `model.onnx` (34,014,426 bytes), `tokenizer.json`, `tokenizer_config.json`. The catalog entry is `KVOX_LOCAL_EMBEDDING` (id `bge-small-en-v1.5-int8`, permanent once vectors are stored; `createKvoxAi` zero-pads 384 to the 1536-wide column and applies the query prefix).
- **Download.** `downloadLocalEmbeddingModel({ directory, signal?, onProgress?(received, total), fetch? })` installs `<directory>/<model id>/` with an `installed.json` record. Every URL is pinned to a Hugging Face commit and every file to an exact size and SHA-256; the shared verified downloader accepts https only, no credentials or port, an EXACT host match on the first URL and on EVERY redirect hop (`LOCAL_EMBEDDING_DOWNLOAD_HOSTS`: `huggingface.co` plus Hugging Face CDN hosts; the hash guarantees integrity, the list bounds egress), at most 5 redirects, streaming to a staging directory while hashing, a byte cap, and an atomic rename of the whole directory. A failure or abort installs nothing. Already installed: returns at once, no request. `localEmbeddingModelStatus(directory)` and `removeLocalEmbeddingModel(directory)` complete it. Errors are `LocalEmbeddingDownloadError` with a `code`.
- **Embedder.** `createLocalEmbedder({ modelPath, numThreads? })` returns `{ model, dimensions: 384, embed(texts), dispose() }`. It truncates to 512 tokens keeping the final [SEP], pads the batch with attention mask 0, runs batches of at most 32 and serialises calls. The optional peers `onnxruntime-web` (1.30.0) and `@huggingface/tokenizers` (0.2.0) are loaded lazily; the WASM binary is read with `fs`, so it works inside an Electron `app.asar`.
- **Runtime.** `createLocalEmbeddingRuntime({ embed(texts, purpose), ready() })` is a `KvoxAiRuntime` that only embeds; every other method throws a `capability` `KvoxAiError`. `readiness()` is `{ hasKey: await ready() }` ("the model is present"). The `embed` callback is the host's transport.

### Run it off the event loop

`session.run` BLOCKS the thread: about 0.5 s per 300-token chunk on one thread, and a measured 6.7 s with no timer firing. Never call `embed` in the process that serves the UI. KVox Desktop runs the embedder in a dedicated Electron utility process; any worker thread or child process does the same job.

### Wiring a host

```ts
import { createKvoxAi, KVOX_LOCAL_EMBEDDING } from '@marinoscar/kvox-ai';
import {
  createLocalEmbeddingRuntime, downloadLocalEmbeddingModel, localEmbeddingModelStatus,
} from '@marinoscar/kvox-ai/local-embeddings';

const modelsDir = join(app.getPath('userData'), 'models');
await downloadLocalEmbeddingModel({ directory: modelsDir, onProgress: (r, t) => ui.progress(r / t) });

// In the utility process: const embedder = await createLocalEmbedder({ modelPath });
const ai = createKvoxAi({
  runtime: createLocalEmbeddingRuntime({
    embed: (texts, purpose) => utility.request({ texts, purpose }),   // -> embedder.embed(texts)
    ready: async () => (await localEmbeddingModelStatus(modelsDir)).installed,
  }),
  embedding: KVOX_LOCAL_EMBEDDING,
  // ...taskModels, catalog, as the host already does for chat
});
```

Prefixes are applied by the port (`createKvoxAi`), never by this runtime or the embedder.

### Tests

Unit specs use a local `http` server behind an injected `fetch` and a fake session and tokenizer. `local-embedder.integration.spec.ts` runs only when `KVOX_LOCAL_EMBEDDING_MODEL_DIR` points at an installed model directory (and `NODE_OPTIONS=--experimental-vm-modules` under Jest).

## Entry point

`@marinoscar/kvox-ai/local-embeddings`. Deliberately NOT re-exported by the package root, so a host that never imports it never loads (or needs) the optional peers.

## Peer dependencies

`onnxruntime-web` `1.30.0` and `@huggingface/tokenizers` `0.2.0`, both OPTIONAL peers (`peerDependenciesMeta`) loaded lazily by `createLocalEmbedder` only; the downloader, the manifest and the runtime adapter run without them. `@marinoscar/kvox-api` (`KvoxAiError`) and `@marinoscar/platform-ai-providers` (types, through the `runtime` slice). It imports the `download`, `embedding` and `runtime` slices.

## Configuration

No environment variable and no settings key of its own. The host passes `directory` (an app-private models folder) to the download, status and removal functions, `modelPath` and `numThreads` (default 1) to the embedder, and the `embed` transport and `ready` check to the runtime. `manifest` and `allowedHosts` on the download are for a mirror or a test; the defaults are the pinned manifest and `LOCAL_EMBEDDING_DOWNLOAD_HOSTS`.

## Extension-point catalog

None. `LocalEmbeddingRuntimeOptions.embed` is the host's transport (it is how Desktop reaches its utility process), not a registry.
