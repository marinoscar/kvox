import type { DynamicModule } from '@nestjs/common';

import {
  ASK_MAX_TOOL_CALLS_PER_STEP,
  ASK_MAX_TOOL_STEPS,
  ASK_WALL_CLOCK_SOFT_MS,
} from './ask-limits.js';
import { DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS, DEFAULT_STREAM_POLL_INTERVAL_MS } from '../core/index.js';

// =============================================================================
// AskModule options (issue #497, epic #491)
// =============================================================================
//
// Plain data plus module bindings, as every slice's `forRoot` takes. No environment variable
// is read inside the package: a host reads its own configuration and passes values.
//
// ⚠ A HOST MAY LOWER THE TURN'S CAPS, NEVER RAISE THEM. Each cap bounds what one `ask.respond`
// turn may cost the asker (their OWN AI key) and how long they wait; a deployment that
// could make a turn bill more than the product's published numbers would be spending
// somebody's money on its own say-so. `resolveAskOptions` throws at boot for a value above
// today's, so a mistake fails the start and never a user's turn.
// =============================================================================

/**
 * The caps of one Ask turn. Every field may only be LOWERED from its default.
 *
 * @stability experimental
 */
export interface AskLimitsOptions {
  /** Model calls that may request tools (default 8, the most it may be). */
  maxSteps?: number;
  /** Tool calls executed per step (default 4, the most it may be). */
  maxCallsPerStep?: number;
  /** Wall clock after which the next call is forced to answer, in milliseconds (default 240 000, the most it may be). */
  softClockMs?: number;
}

/**
 * How the answer stream is paced.
 *
 * @stability experimental
 */
export interface AskStreamOptions {
  /** Milliseconds between reads of the answer row (default 250). */
  pollIntervalMs?: number;
  /** Milliseconds between heartbeat comments (default 25 000). */
  heartbeatMs?: number;
}

/**
 * Options of `AskModule.forRoot`.
 *
 * @example
 * ```ts
 * AskModule.forRoot({
 *   limits: { maxSteps: 5 },
 *   peers: { graph: GraphModule.forRoot(), notes: NotesModule.forRoot(), search: SearchModule.forRoot() },
 * });
 * ```
 *
 * @stability experimental
 */
export interface AskModuleOptions {
  /** The turn's caps; each may only be lowered from today's value. */
  limits?: AskLimitsOptions;

  /** The answer stream's pacing. */
  stream?: AskStreamOptions;

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
    /** `GraphModule.forRoot(...)`: the read services the tools use, and graph access. */
    graph?: DynamicModule;
    /** `NotesModule.forRoot(...)`: imported by the graph slice and shared here. */
    notes?: DynamicModule;
    /** `SearchModule.forRoot(...)`: `SearchService` and the host's transcript-visibility rule. */
    search?: DynamicModule;
  };
}

/**
 * The options with defaults applied, as the providers read them.
 *
 * @stability experimental
 */
export interface ResolvedAskOptions {
  /** The caps of one turn. */
  limits: {
    /** Model calls that may request tools. */
    maxSteps: number;
    /** Tool calls executed per step. */
    maxCallsPerStep: number;
    /** Wall clock after which the next call is forced to answer. */
    softClockMs: number;
  };
  /** The answer stream's pacing. */
  stream: {
    /** Milliseconds between reads. */
    pollIntervalMs: number;
    /** Milliseconds between heartbeats. */
    heartbeatMs: number;
  };
}

/**
 * Injection token of the resolved options. The description string is permanent.
 *
 * @stability experimental
 */
export const ASK_MODULE_OPTIONS = Symbol.for('@marinoscar/kvox/ASK_MODULE_OPTIONS');

/** A cap is a positive integer no larger than the product's own value. */
function lowered(name: string, value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`AskModule.forRoot: limits.${name} must be a positive integer (got ${String(value)}).`);
  }
  if (value > ceiling) {
    throw new Error(
      `AskModule.forRoot: limits.${name} may only be lowered, never raised above ${ceiling} (got ${value}); a host must not be able to make a turn bill more than the product's own cap.`,
    );
  }

  return value;
}

/** A pacing number is a positive integer. */
function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`AskModule.forRoot: stream.${name} must be a positive integer (got ${String(value)}).`);
  }

  return value;
}

/**
 * Applies the defaults to a host's options and refuses a cap above today's value.
 *
 * @param options - what the host passed to `forRoot`.
 * @returns the resolved options.
 * @throws Error when a limit is not a positive integer or is above the product's own cap.
 * @stability experimental
 */
export function resolveAskOptions(options: AskModuleOptions = {}): ResolvedAskOptions {
  return {
    limits: {
      maxSteps: lowered('maxSteps', options.limits?.maxSteps, ASK_MAX_TOOL_STEPS),
      maxCallsPerStep: lowered('maxCallsPerStep', options.limits?.maxCallsPerStep, ASK_MAX_TOOL_CALLS_PER_STEP),
      softClockMs: lowered('softClockMs', options.limits?.softClockMs, ASK_WALL_CLOCK_SOFT_MS),
    },
    stream: {
      pollIntervalMs: positive('pollIntervalMs', options.stream?.pollIntervalMs, DEFAULT_STREAM_POLL_INTERVAL_MS),
      heartbeatMs: positive('heartbeatMs', options.stream?.heartbeatMs, DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS),
    },
  };
}
