import type { DynamicModule } from '@nestjs/common';

import { GRAPH_IMPORT_MAX_BYTES } from './import/graph-import.constants.js';

// =============================================================================
// GraphRdfModule options (issue #496, epic #491)
// =============================================================================
//
// Plain data plus module bindings, as every slice's `forRoot` takes. No environment
// variable is read inside the package: a host reads its own configuration and passes
// values.
// =============================================================================

/**
 * Options of `GraphRdfModule.forRoot`.
 *
 * @example
 * ```ts
 * GraphRdfModule.forRoot({
 *   peers: { graph: GraphModule.forRoot(), extraction: GraphExtractionModule.forRoot() },
 * });
 * ```
 *
 * @stability experimental
 */
export interface GraphRdfModuleOptions {
  /** Offer the RDF data export (`/api/graph/exports`, `kg.export`). Default true. */
  export?: boolean;

  /**
   * Offer the RDF import (`/api/graph/imports`, `kg.import`). Default true. It needs the
   * optional peer `rdf-validate-shacl`: the module refuses to start, naming it, when the
   * package cannot be resolved.
   */
  import?: boolean;

  /** The largest file one import accepts, in bytes. Default 20 MiB. */
  maxImportBytes?: number;

  /**
   * Register the export-expiry cron with `@nestjs/schedule` (default true). False exposes the
   * enqueuer for a host without `ScheduleModule`, which calls its `enqueue()` itself. A cron
   * only enqueues; a registered job does the work.
   */
  schedules?: boolean;

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
    /** `GraphModule.forRoot(...)`: ontology, access, attribute definitions and the object store. */
    graph?: DynamicModule;
    /** `GraphExtractionModule.forRoot(...)`: the proposal stage registry. */
    extraction?: DynamicModule;
    /** `TranscriptsModule.forRoot(...)`: whether an evidence citation's transcript is still viewable. */
    transcripts?: DynamicModule;
    /** `NotesModule.forRoot(...)`: whether an evidence citation's note is still readable. */
    notes?: DynamicModule;
  };
}

/**
 * The options with defaults applied, as the providers read them.
 *
 * @stability experimental
 */
export interface ResolvedGraphRdfOptions {
  /** Whether the export half is mounted. */
  export: boolean;
  /** Whether the import half is mounted. */
  import: boolean;
  /** The largest import file, in bytes. */
  maxImportBytes: number;
  /** Whether the export-expiry cron is registered. */
  schedules: boolean;
}

/**
 * Injection token of the resolved options. The description string is permanent.
 *
 * @stability experimental
 */
export const GRAPH_RDF_OPTIONS = Symbol.for('@marinoscar/kvox/GRAPH_RDF_OPTIONS');

/**
 * Applies the defaults to a host's options.
 *
 * @param options - what the host passed to `forRoot`.
 * @returns the resolved options.
 * @stability experimental
 */
export function resolveGraphRdfOptions(options: GraphRdfModuleOptions): ResolvedGraphRdfOptions {
  return {
    export: options.export !== false,
    import: options.import !== false,
    maxImportBytes: options.maxImportBytes ?? GRAPH_IMPORT_MAX_BYTES,
    schedules: options.schedules !== false,
  };
}
