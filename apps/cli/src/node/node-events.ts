import type { NodeJobAssignment } from './node-api.js';

// =============================================================================
// Engine events  (issue #274, epic #254)
// =============================================================================
//
// The engine is UI-free: it never writes to a stream and never formats a line.
// It emits these, and three separate consumers render them — the plain printer
// in `node start`, the daemon's IPC broadcast (#275) and the TUI (#279). That
// is what lets all three show the same thing without any of them owning the
// engine.
//
// ⚠ EVENTS CARRY PRESIGNED URLS ONLY IN THE `error` KIND, and only when a
// provider put one in a message. The logger's redaction (#275) is what makes
// that safe; nothing here should ADD one deliberately.
// =============================================================================

export type NodeEngineEvent =
  | { kind: 'started'; at: string; nodeId: string; concurrency: number }
  | { kind: 'idle'; at: string }
  | { kind: 'claimed'; at: string; jobs: NodeJobAssignment[] }
  | { kind: 'job-started'; at: string; jobId: string; type: string }
  | { kind: 'job-input'; at: string; jobId: string; objectId: string; bytes: string }
  | { kind: 'job-log'; at: string; jobId: string; type: string; message: string; fields?: Record<string, unknown> }
  | { kind: 'job-succeeded'; at: string; jobId: string; type: string; durationMs: number; outcome: string }
  | {
      kind: 'job-failed';
      at: string;
      jobId: string;
      type: string;
      durationMs: number;
      error: string;
      rateLimited: boolean;
      willRetry: boolean;
    }
  | { kind: 'lease-renewed'; at: string; jobId: string; leaseExpiresAt: string }
  | { kind: 'lease-renew-failed'; at: string; jobId: string; error: string }
  | { kind: 'heartbeat'; at: string; concurrency: number }
  | { kind: 'heartbeat-failed'; at: string; error: string }
  | { kind: 'concurrency-changed'; at: string; concurrency: number }
  | { kind: 'claim-failed'; at: string; error: string }
  | { kind: 'draining'; at: string; inFlight: number }
  | { kind: 'stopped'; at: string; deregistered: boolean };

/** A job this node is running right now. */
export interface ActiveJob {
  jobId: string;
  type: string;
  startedAt: string;
  attempts: number;
  leaseExpiresAt: string | null;
}

/** One settled job in the bounded history ring. */
export interface HistoryEntry {
  jobId: string;
  type: string;
  outcome: 'succeeded' | 'failed';
  durationMs: number;
  finishedAt: string;
  error?: string;
  rateLimited?: boolean;
}

/** Cumulative since this process started. Never reset. */
export interface NodeCounters {
  claimed: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
}

/** What `node status`, the daemon IPC and the TUI all render. One shape. */
export interface NodeSnapshot {
  nodeId: string;
  status: 'starting' | 'idle' | 'working' | 'draining' | 'stopped';
  concurrency: number;
  eligibleTypes: string[];
  activeJobs: ActiveJob[];
  history: HistoryEntry[];
  counters: NodeCounters;
  startedAt: string;
  lastHeartbeatAt: string | null;
  /** Milliseconds since the last successful heartbeat; `null` before the first. */
  heartbeatAgeMs: number | null;
}
