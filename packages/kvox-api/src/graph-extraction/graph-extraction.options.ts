import type { DynamicModule } from '@nestjs/common';

// =============================================================================
// GraphExtractionModule options (issue #496, epic #491)
// =============================================================================
//
// Plain data plus module bindings, as every slice's `forRoot` takes. No environment
// variable is read inside the package: a host reads its own configuration and passes
// values.
// =============================================================================

/**
 * Options of `GraphExtractionModule.forRoot`.
 *
 * @example
 * ```ts
 * GraphExtractionModule.forRoot({
 *   peers: { graph: GraphModule.forRoot(), notes: NotesModule.forRoot() },
 *   embedding: { batchSize: 128 },
 * });
 * ```
 *
 * @stability experimental
 */
export interface GraphExtractionModuleOptions {
  /**
   * Subscribe to `kvox.notes.note_ready` and extract a note that just became ready, when the
   * deployment's graph switch is on, the owner holds `graph:write` and their
   * `extraction.autoExtract` preference is on (default true). False leaves extraction to the
   * explicit `POST /api/graph/notes/:noteId/extract`.
   */
  autoExtract?: boolean;

  /** The embeddings the graph requests. */
  embedding?: {
    /** The most texts one embeddings request carries. Default 128. */
    batchSize?: number;
  };

  /**
   * Modules the host's own classes need. Imported by the slice's module so those
   * providers resolve.
   */
  imports?: DynamicModule[];

  /**
   * The modules of the peer slices this one imports. Pass the objects the host imports
   * itself: the module imports them to reach the providers they export, and NEVER provides
   * those providers a second time. Absent, each is built with its defaults, which is only
   * right when the host imports the defaults too.
   */
  peers?: {
    /** `GraphModule.forRoot(...)`: write, access, read, ontology and preferences services. */
    graph?: DynamicModule;
    /** `NotesModule.forRoot(...)`: `NoteAccessService` and `NoteOriginService`. */
    notes?: DynamicModule;
  };
}

/**
 * The options with defaults applied, as the providers read them.
 *
 * @stability experimental
 */
export interface ResolvedGraphExtractionOptions {
  /** Whether a ready note is extracted automatically. */
  autoExtract: boolean;
  /** The most texts one embeddings request carries. */
  embeddingBatchSize: number;
}

/** The default size of one embeddings request. @stability experimental */
export const DEFAULT_EMBEDDING_BATCH_SIZE = 128;

/**
 * Injection token of the resolved options. The description string is permanent.
 *
 * @stability experimental
 */
export const GRAPH_EXTRACTION_OPTIONS = Symbol.for('@marinoscar/kvox/GRAPH_EXTRACTION_OPTIONS');

/**
 * Applies the defaults to a host's options.
 *
 * @param options - what the host passed to `forRoot`.
 * @returns the resolved options.
 * @stability experimental
 */
export function resolveGraphExtractionOptions(options: GraphExtractionModuleOptions): ResolvedGraphExtractionOptions {
  return {
    autoExtract: options.autoExtract !== false,
    embeddingBatchSize: Math.max(1, options.embedding?.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE),
  };
}
