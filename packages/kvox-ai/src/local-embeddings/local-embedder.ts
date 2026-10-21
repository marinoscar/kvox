import * as fs from 'node:fs';
import { dirname, join } from 'node:path';

// =============================================================================
// The on-device embedder: onnxruntime-web (WASM) + @huggingface/tokenizers (#660)
// =============================================================================
//
// ⚠ BLOCKING. `session.run` executes the model on the calling thread and holds
// the event loop for its whole duration: about 0.5 s per 300-token chunk on one
// thread, and a measured 6.7 s during which not a single timer fired. RUN THIS
// OFF THE EVENT LOOP: in a worker thread, a child process, or (KVox Desktop) a
// dedicated Electron utility process, and send texts to it over a message channel.
// Never call `embed` in the process that serves a UI or an HTTP request.
//
// Pipeline (bge-small-en-v1.5): tokenise ([CLS] ... [SEP]), truncate to 512
// tokens KEEPING the final [SEP], pad the batch with attention mask 0, run the
// session (`input_ids`, `attention_mask`, `token_type_ids`: int64), take the CLS
// vector (index 0) of `last_hidden_state`, L2-normalise it.
//
// `onnxruntime-web` and `@huggingface/tokenizers` are OPTIONAL peers, loaded
// lazily with `require` so that importing this entry costs nothing and a host
// that never embeds locally never installs them. The WASM binary is read with
// `fs` and handed to the runtime, so it works from inside an Electron `app.asar`.
// =============================================================================

/**
 * Tokens in one input after truncation, [CLS] and [SEP] included.
 *
 * @stability experimental
 */
export const LOCAL_EMBEDDING_MAX_TOKENS = 512;
/**
 * Texts per model run (the port batches at the same size).
 *
 * @stability experimental
 */
export const LOCAL_EMBEDDING_MAX_BATCH = 32;
/**
 * The width of a vector.
 *
 * @stability experimental
 */
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

/**
 * What {@link createLocalEmbedder} returns.
 *
 * @stability experimental
 */
export interface LocalEmbedder {
  /** The model id (`KVOX_LOCAL_EMBEDDING.model`). */
  readonly model: string;
  /** The vector width. */
  readonly dimensions: 384;
  /**
   * Embeds texts, one unit-length 384-wide vector each, in order. BLOCKS the
   * event loop while the model runs; call it off the event loop. Calls are
   * serialised. An empty string is valid.
   */
  embed(texts: string[]): Promise<number[][]>;
  /** Releases the model. The embedder cannot be used afterwards. */
  dispose(): Promise<void>;
}

/**
 * What {@link createLocalEmbedder} takes.
 *
 * @stability experimental
 */
export interface CreateLocalEmbedderOptions {
  /** The installed model directory (`downloadLocalEmbeddingModel(...).path`). */
  modelPath: string;
  /** WASM threads. Default 1 (the measured-safe value; more needs cross-origin isolation in a browser). */
  numThreads?: number;
}

// --- the minimal shapes of the two optional peers ---------------------------------------

/**
 * The part of an `onnxruntime-web` tensor this module uses.
 *
 * @stability experimental
 */
export interface EmbedderTensorCtor {
  new (type: 'int64', data: BigInt64Array, dims: number[]): unknown;
}
/**
 * One session output tensor.
 *
 * @stability experimental
 */
export interface EmbedderOutput {
  /** The flattened values. */
  data: ArrayLike<number>;
  /** The shape. */
  dims: readonly number[];
}
/**
 * One tokenizer encoding.
 *
 * @stability experimental
 */
export interface EmbedderEncoding {
  /** The token ids, `[CLS] ... [SEP]`. */
  ids: number[];
}
/**
 * The part of an `onnxruntime-web` session this module uses.
 *
 * @stability experimental
 */
export interface EmbedderSession {
  /**
   * Runs the model.
   *
   * @param feeds - `input_ids`, `attention_mask` and `token_type_ids` tensors.
   * @returns the named outputs; `last_hidden_state` is `[batch, seq, hidden]`, flattened.
   */
  run(feeds: Record<string, unknown>): Promise<Record<string, EmbedderOutput>>;
  /** Frees the model's memory. */
  release?(): Promise<void> | void;
}
/**
 * The part of a `@huggingface/tokenizers` tokenizer this module uses.
 *
 * @stability experimental
 */
export interface EmbedderTokenizer {
  /**
   * Tokenises one text.
   *
   * @param text - the text.
   * @returns the token ids, `[CLS] ... [SEP]`.
   */
  encode(text: string): EmbedderEncoding;
}

/**
 * Everything the embedding maths needs, so a test can supply fakes.
 *
 * @stability experimental
 */
export interface EmbedderParts {
  /** The loaded model session. */
  session: EmbedderSession;
  /** The model's tokenizer. */
  tokenizer: EmbedderTokenizer;
  /** The runtime's tensor constructor. */
  Tensor: EmbedderTensorCtor;
}

/**
 * Cuts a token list to `max` tokens, keeping its final token (the [SEP]).
 *
 * @param ids - the encoding, `[CLS] ... [SEP]`.
 * @param max - the ceiling.
 * @returns `ids` when short enough, else the first `max - 1` ids plus the last.
 *
 * @stability experimental
 */
export function truncateKeepingSep(ids: readonly number[], max: number = LOCAL_EMBEDDING_MAX_TOKENS): number[] {
  if (ids.length <= max) return ids.slice();
  return [...ids.slice(0, max - 1), ids[ids.length - 1] as number];
}

/**
 * CLS-pools a `[batch, seq, hidden]` buffer and L2-normalises each vector.
 *
 * @param data - the flattened `last_hidden_state`.
 * @param batch - texts in the batch.
 * @param seq - the padded sequence length.
 * @param hidden - the model width.
 * @returns one unit vector per text (a zero vector stays zero).
 *
 * @stability experimental
 */
export function clsPoolNormalize(data: ArrayLike<number>, batch: number, seq: number, hidden: number): number[][] {
  const out: number[][] = [];
  for (let b = 0; b < batch; b += 1) {
    const start = b * seq * hidden; // token 0 of text b
    const v = new Array<number>(hidden);
    let sum = 0;
    for (let i = 0; i < hidden; i += 1) {
      const x = data[start + i] as number;
      v[i] = x;
      sum += x * x;
    }
    const norm = Math.sqrt(sum);
    out.push(norm > 0 ? v.map((x) => x / norm) : v);
  }
  return out;
}

/**
 * The embedder over already-loaded parts. {@link createLocalEmbedder} loads the
 * real ones; tests pass fakes.
 *
 * @param parts - the session, tokenizer and tensor constructor.
 * @param model - the model id to report.
 * @returns the embedder.
 *
 * @stability experimental
 */
export function createEmbedderFromParts(parts: EmbedderParts, model: string): LocalEmbedder {
  let chain: Promise<unknown> = Promise.resolve();
  let disposed = false;

  const runBatch = async (texts: string[]): Promise<number[][]> => {
    const encoded = texts.map((t) => truncateKeepingSep(parts.tokenizer.encode(t).ids));
    const seq = Math.max(...encoded.map((e) => e.length));
    const n = texts.length;
    const ids = new BigInt64Array(n * seq);
    const mask = new BigInt64Array(n * seq);
    encoded.forEach((e, row) => {
      for (let i = 0; i < e.length; i += 1) {
        ids[row * seq + i] = BigInt(e[i] as number);
        mask[row * seq + i] = 1n;
      }
    });
    const dims = [n, seq];
    const result = await parts.session.run({
      input_ids: new parts.Tensor('int64', ids, dims),
      attention_mask: new parts.Tensor('int64', mask, dims),
      token_type_ids: new parts.Tensor('int64', new BigInt64Array(n * seq), dims),
    });
    const out = result.last_hidden_state;
    if (!out) throw new Error('The embedding model returned no last_hidden_state.');
    const hidden = out.dims[out.dims.length - 1] as number;
    if (hidden !== LOCAL_EMBEDDING_DIMENSIONS) {
      throw new Error(`The embedding model is ${hidden} wide, expected ${LOCAL_EMBEDDING_DIMENSIONS}.`);
    }
    return clsPoolNormalize(out.data, n, seq, hidden);
  };

  const embedAll = async (texts: string[]): Promise<number[][]> => {
    if (disposed) throw new Error('The local embedder was disposed.');
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += LOCAL_EMBEDDING_MAX_BATCH) {
      vectors.push(...(await runBatch(texts.slice(i, i + LOCAL_EMBEDDING_MAX_BATCH))));
    }
    return vectors;
  };

  return {
    model,
    dimensions: 384,
    embed(texts) {
      const next = chain.then(() => embedAll(texts));
      chain = next.catch(() => undefined);
      return next;
    },
    async dispose() {
      disposed = true;
      await chain;
      await parts.session.release?.();
    },
  };
}

/**
 * Loads the model and returns an embedder. See the file header: the embedder
 * BLOCKS the event loop; run it off the event loop.
 *
 * @param o - the installed model directory and optional thread count.
 * @returns the embedder.
 * @throws Error when `onnxruntime-web` or `@huggingface/tokenizers` is not installed, or a model file is missing.
 *
 * @stability experimental
 */
export async function createLocalEmbedder(o: CreateLocalEmbedderOptions): Promise<LocalEmbedder> {
  const ort = requirePeer('onnxruntime-web') as OrtModule;
  const { Tokenizer } = requirePeer('@huggingface/tokenizers') as {
    Tokenizer: new (json: unknown, config: unknown) => EmbedderTokenizer;
  };

  const wasmDist = dirname(require.resolve('onnxruntime-web'));
  ort.env.wasm.numThreads = o.numThreads ?? 1;
  ort.env.wasm.proxy = false;
  // Read through fs, never by URL: works from inside an Electron app.asar.
  ort.env.wasm.wasmBinary = fs.readFileSync(join(wasmDist, 'ort-wasm-simd-threaded.wasm'));

  const session = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(join(o.modelPath, 'model.onnx'))), {
    executionProviders: ['wasm'],
  });
  const tokenizer = new Tokenizer(
    JSON.parse(fs.readFileSync(join(o.modelPath, 'tokenizer.json'), 'utf8')),
    JSON.parse(fs.readFileSync(join(o.modelPath, 'tokenizer_config.json'), 'utf8')),
  );
  return createEmbedderFromParts({ session, tokenizer, Tensor: ort.Tensor }, 'bge-small-en-v1.5-int8');
}

interface OrtModule {
  env: { wasm: { numThreads: number; proxy: boolean; wasmBinary: unknown } };
  InferenceSession: { create(model: Uint8Array, options?: unknown): Promise<EmbedderSession> };
  Tensor: EmbedderTensorCtor;
}

function requirePeer(name: string): unknown {
  try {
    return require(name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `Local embeddings need the optional package "${name}". Install it next to @marinoscar/kvox-ai (npm install ${name}).`,
      );
    }
    throw err;
  }
}
