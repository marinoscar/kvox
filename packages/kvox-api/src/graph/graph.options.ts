import type { DynamicModule } from '@nestjs/common';

// =============================================================================
// GraphModule options (issue #496, epic #491)
// =============================================================================
//
// Plain data plus module bindings, as every slice's `forRoot` takes. No environment
// variable is read inside the package: a host reads its own configuration and passes
// values.
// =============================================================================

/**
 * How the whole-graph overview layout is scheduled.
 *
 * @stability experimental
 */
export interface GraphLayoutOptions {
  /** How long an automatic layout waits so a burst of commits coalesces, in milliseconds. Default 120 000. */
  coalesceMs?: number;
  /** The relative change in readable entities that counts as material, 0 to 1. Default 0.2. */
  materialChange?: number;
}

/**
 * Options of `GraphModule.forRoot`.
 *
 * @example
 * ```ts
 * GraphModule.forRoot({
 *   peers: { transcripts: TranscriptsModule.forRoot(), notes: NotesModule.forRoot(), search: SearchModule.forRoot() },
 * });
 * ```
 *
 * @stability experimental
 */
export interface GraphModuleOptions {
  /**
   * Register the `kg.migrate` scheduler with `@nestjs/schedule` (default true). False exposes
   * the scheduler's `enqueue()` for a host without `ScheduleModule`, which calls it itself.
   * A cron only enqueues; a registered job does the work.
   */
  schedules?: boolean;

  /** The overview layout's tuning. */
  layout?: GraphLayoutOptions;

  /** The `kg.migrate` scheduler. */
  migrate?: {
    /** Whether a tick queues any migration; read at every tick. Default: always. */
    scheduleEnabled?: () => boolean;
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
    /** `TranscriptsModule.forRoot(...)`: transcript access and sharing. */
    transcripts?: DynamicModule;
    /** `NotesModule.forRoot(...)`: `NoteAccessService`, `NoteOriginService`, `NoteExportService`. */
    notes?: DynamicModule;
    /** `SearchModule.forRoot(...)`: `SearchService`, the entity brief's text arm. */
    search?: DynamicModule;
  };
}

/**
 * The options with defaults applied, as the providers read them.
 *
 * @stability experimental
 */
export interface ResolvedGraphOptions {
  /** Whether the `kg.migrate` cron is registered. */
  schedules: boolean;
  /** The overview layout's coalescing delay, in milliseconds. */
  layoutCoalesceMs: number;
  /** The relative entity-count change that triggers a new layout. */
  layoutMaterialChange: number;
  /** Whether the `kg.migrate` scheduler may queue work now; read at every tick. */
  migrateScheduleEnabled: () => boolean;
}

/** The default coalescing delay of an automatic layout. @stability experimental */
export const DEFAULT_LAYOUT_COALESCE_MS = 120_000;

/** The default relative change that counts as material. @stability experimental */
export const DEFAULT_LAYOUT_MATERIAL_CHANGE = 0.2;

/**
 * Injection token of the resolved options. The description string is permanent.
 *
 * @stability experimental
 */
export const GRAPH_MODULE_OPTIONS = Symbol.for('@marinoscar/kvox/GRAPH_MODULE_OPTIONS');

/**
 * Applies the defaults to a host's options.
 *
 * @param options - what the host passed to `forRoot`.
 * @returns the resolved options.
 * @stability experimental
 */
export function resolveGraphOptions(options: GraphModuleOptions): ResolvedGraphOptions {
  return {
    schedules: options.schedules !== false,
    layoutCoalesceMs: options.layout?.coalesceMs ?? DEFAULT_LAYOUT_COALESCE_MS,
    layoutMaterialChange: options.layout?.materialChange ?? DEFAULT_LAYOUT_MATERIAL_CHANGE,
    migrateScheduleEnabled: options.migrate?.scheduleEnabled ?? (() => true),
  };
}
