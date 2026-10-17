import type { Type } from '@nestjs/common';
import type { SearchType } from '@marinoscar/kvox-contract/search';

import type { SemanticReason } from './search-semantic.js';
import type { SearchTranscriptVisibility } from './search-visibility.js';

// =============================================================================
// Options of the search slice (issue #494, epic #491)
// =============================================================================
//
// Plain data plus `Type<...>` bindings, as every slice's `forRoot` takes. No
// environment variable is read inside the package: a host reads its own
// configuration and passes values.
// =============================================================================

/**
 * The width of every stored vector. The index column is `vector(1536)`: a host
 * whose embeddings model has another width cannot store vectors, so semantic
 * search is off for it (reason `embeddings_unavailable`), never truncated or
 * padded. A per-model column is a later migration in `@marinoscar/kvox-db`.
 *
 * @stability experimental
 */
export const SEARCH_EMBEDDING_DIMENSIONS = 1536;

/**
 * The most texts one embeddings request carries when the host does not say
 * otherwise (the web edition's provider accepts 128).
 *
 * @stability experimental
 */
export const SEARCH_DEFAULT_BATCH_SIZE = 128;

/**
 * The permission each document type needs, the strings the host's own
 * controllers enforce. A caller holding one of them gets that type searched; a
 * caller holding none gets a 403.
 *
 * @stability experimental
 */
export type SearchTypePermissions = Readonly<Record<SearchType, string>>;

/**
 * The permissions used when {@link SearchModuleOptions.typePermissions} names
 * none: the web edition's.
 *
 * @stability experimental
 */
export const DEFAULT_SEARCH_TYPE_PERMISSIONS: SearchTypePermissions = {
  transcript: 'transcripts:read',
  note: 'notes:read',
};

/**
 * Options of `SearchModule.forRoot`.
 *
 * @example
 * ```ts
 * SearchModule.forRoot({
 *   semantic: { enabled: true, provider: 'openai' },
 *   transcriptVisibility: SharedTranscriptVisibility,
 * });
 * ```
 *
 * @stability experimental
 */
export interface SearchModuleOptions {
  /** The semantic (vector) arm. */
  semantic?: {
    /**
     * Switches the arm off for this host. Default: on whenever the host's AI
     * port reports a 1536-wide embeddings model.
     */
    enabled?: boolean;

    /**
     * The label that, with the model the host reports, names the semantic axis of
     * a cursor's fingerprint. Changing it invalidates in-flight cursors, like a
     * change of embeddings model does. Default `embeddings`.
     */
    provider?: string;

    /**
     * Called, at most once per request, with the reason the arm did not run. The
     * web edition records it as a span attribute (`kvox.search.semantic_reason`);
     * the slice itself reads no telemetry package. Must not throw.
     */
    onSemanticOff?: (reason: SemanticReason) => void;
  };

  /**
   * Which transcripts a caller may see. Default: the ones they own
   * (`OwnerOnlyTranscriptVisibility`). The web edition adds the ones shared with
   * them.
   *
   * @extensionPoint
   */
  transcriptVisibility?: Type<SearchTranscriptVisibility>;

  /** The permission each type needs; the defaults are the web edition's strings. */
  typePermissions?: Partial<SearchTypePermissions>;
}

/**
 * Options of `SearchIndexingModule.forRoot`.
 *
 * @stability experimental
 */
export interface SearchIndexingModuleOptions {
  /**
   * The most chunk texts one embeddings request carries. Default
   * {@link SEARCH_DEFAULT_BATCH_SIZE}.
   */
  batchSize?: number;
}

/**
 * Injection token of the resolved {@link SearchModuleOptions} (defaults applied).
 *
 * @stability experimental
 */
export const SEARCH_MODULE_OPTIONS = Symbol.for('@marinoscar/kvox/SEARCH_MODULE_OPTIONS');

/**
 * Injection token of the resolved {@link SearchIndexingModuleOptions}.
 *
 * @stability experimental
 */
export const SEARCH_INDEXING_MODULE_OPTIONS = Symbol.for('@marinoscar/kvox/SEARCH_INDEXING_MODULE_OPTIONS');

/**
 * What the query side reads at run time: {@link SearchModuleOptions} with the
 * defaults applied.
 *
 * @stability experimental
 */
export interface ResolvedSearchOptions {
  /** False when the host switched the vector arm off. */
  semanticEnabled: boolean;
  /** The label that names the semantic axis of a cursor's fingerprint. */
  provider: string;
  /** The host's hook for the reason the vector arm did not run. */
  onSemanticOff?: (reason: SemanticReason) => void;
  /** The permission each document type needs. */
  typePermissions: SearchTypePermissions;
}

/**
 * What the indexing side reads at run time: {@link SearchIndexingModuleOptions}
 * with the defaults applied.
 *
 * @stability experimental
 */
export interface ResolvedSearchIndexingOptions {
  /** The most chunk texts one embeddings request carries. */
  batchSize: number;
}
