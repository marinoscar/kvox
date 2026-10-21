import { KvoxAiError } from '@marinoscar/kvox-api/ports';

import { KVOX_LOCAL_EMBEDDING } from '../embedding/index.js';
import type { KvoxAiRuntime } from '../runtime/index.js';

/**
 * What {@link createLocalEmbeddingRuntime} takes.
 *
 * @stability experimental
 */
export interface LocalEmbeddingRuntimeOptions {
  /**
   * Embeds texts and returns one 384-wide vector each. The HOST's transport:
   * KVox Desktop sends the texts to its utility process and returns the answer;
   * a test returns fixed vectors. The texts already carry the query prefix (the
   * port applies it); this callback must not add one.
   */
  embed(texts: string[], purpose: 'query' | 'document'): Promise<number[][]>;
  /** Whether the model is installed and the embedder can run (`hasKey` for a keyless model). */
  ready(): boolean | Promise<boolean>;
}

const ONLY_EMBEDS = 'The local runtime only embeds; it cannot generate text.';

/**
 * A {@link KvoxAiRuntime} that only embeds, over the host's transport.
 *
 * @remarks
 * Pass it to `createKvoxAi({ runtime, embedding: KVOX_LOCAL_EMBEDDING })`. The
 * port applies the query/document prefix and zero-pads 384 to 1536; this runtime
 * does neither. `readiness()` answers `{ hasKey: await ready() }`: for a keyless
 * model "has a key" means "the model is present". Every other method throws a
 * `capability` `KvoxAiError`. A host that also chats composes this with its chat
 * runtime and routes `embed`/`readiness` for provider `local` here.
 *
 * @param o - the embed transport and the readiness check.
 * @returns the runtime.
 *
 * @stability experimental
 */
export function createLocalEmbeddingRuntime(o: LocalEmbeddingRuntimeOptions): KvoxAiRuntime {
  return {
    stream() {
      throw new KvoxAiError('capability', ONLY_EMBEDS);
    },
    create() {
      return Promise.reject(new KvoxAiError('capability', ONLY_EMBEDS));
    },
    async embed(_call, req) {
      const vectors = await o.embed(req.input, req.purpose ?? 'document');
      return { vectors, inputTokens: null, model: KVOX_LOCAL_EMBEDDING.model };
    },
    async readiness() {
      return { hasKey: await o.ready() };
    },
  };
}
