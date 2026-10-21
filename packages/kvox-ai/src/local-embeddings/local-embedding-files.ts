// =============================================================================
// The pinned files of KVOX_LOCAL_EMBEDDING (issue #660)
// =============================================================================
//
// MODEL: bge-small-en-v1.5 (BAAI), 384-wide, the int8-QUANTIZED ONNX build as
// converted by Xenova (`Xenova/bge-small-en-v1.5`). LICENSE: MIT (the upstream
// BAAI/bge-small-en-v1.5 and the conversion are both MIT).
//
// Every URL names a Hugging Face COMMIT, not a branch, and every file carries its
// exact size and SHA-256, so the bytes cannot change under a user. The model id
// `bge-small-en-v1.5-int8` is permanent once vectors are stored under it: a new
// build or revision is a NEW id with its own manifest, never an edit of this one.
// =============================================================================

/**
 * The Hugging Face commit every file is read from.
 *
 * @stability experimental
 */
export const LOCAL_EMBEDDING_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';

/**
 * One file of a model manifest.
 *
 * @stability experimental
 */
export interface LocalEmbeddingFile {
  /** The file name inside the installed model directory (plain, no separators). */
  name: string;
  /** The https URL it is downloaded from (revision-pinned). */
  url: string;
  /** The exact size in bytes. */
  size: number;
  /** The SHA-256, 64 lowercase hex characters. */
  sha256: string;
}

/**
 * The files and licence of one downloadable model.
 *
 * @stability experimental
 */
export interface LocalEmbeddingManifest {
  /** The model id (`KVOX_LOCAL_EMBEDDING.model`); also the directory name. */
  model: string;
  /** The model's licence (SPDX). */
  license: string;
  /** The files, all required. */
  files: readonly LocalEmbeddingFile[];
}

const BASE = `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/${LOCAL_EMBEDDING_REVISION}`;

/**
 * The manifest for `KVOX_LOCAL_EMBEDDING`: about 34.7 MB in three files.
 *
 * @remarks
 * `model.onnx` is Xenova's `onnx/model_quantized.onnx`, stored under a plain name.
 * License: MIT.
 *
 * @stability experimental
 */
export const LOCAL_EMBEDDING_MANIFEST: LocalEmbeddingManifest = Object.freeze({
  model: 'bge-small-en-v1.5-int8',
  license: 'MIT',
  files: Object.freeze([
    {
      name: 'model.onnx',
      url: `${BASE}/onnx/model_quantized.onnx`,
      size: 34014426,
      sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
    },
    {
      name: 'tokenizer.json',
      url: `${BASE}/tokenizer.json`,
      size: 711396,
      sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
    },
    {
      name: 'tokenizer_config.json',
      url: `${BASE}/tokenizer_config.json`,
      size: 366,
      sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
    },
  ]),
});

/**
 * The only hosts the model download may contact, on the first request and on
 * every redirect hop.
 *
 * @remarks
 * `huggingface.co` answers with a redirect to Hugging Face's CDN. The model file
 * was observed on `us.aws.cdn.hf.co` and a small file on
 * `us.gcp.cdn.hf.co`; `eu.aws.cdn.hf.co`, `eu.gcp.cdn.hf.co` and
 * `cas-bridge.xethub.hf.co` are likely Hugging Face CDN hosts (regional twin and
 * Xet storage bridge) and are not observed. The SHA-256 in the manifest is what
 * guarantees integrity; this list only bounds where the app may connect.
 *
 * @stability experimental
 */
export const LOCAL_EMBEDDING_DOWNLOAD_HOSTS: readonly string[] = Object.freeze([
  'huggingface.co',
  'us.aws.cdn.hf.co', // observed: serves model_quantized.onnx
  'us.gcp.cdn.hf.co', // observed: serves a small file (the download is redirected to it)
  'eu.gcp.cdn.hf.co', // likely: regional twin of the GCP CDN above (not observed)
  'eu.aws.cdn.hf.co', // likely: regional twin of the CDN above (not observed)
  'cas-bridge.xethub.hf.co', // likely: Hugging Face Xet storage bridge (not observed)
]);
