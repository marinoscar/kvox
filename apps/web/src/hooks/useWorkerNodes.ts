/**
 * The worker fleet, its credentials, and the three writes (issue #271, epic #254).
 *
 * Three exports, one file, for the reason `useJobs.ts` gives for holding three:
 * they are three views of ONE surface, and `WorkersPage` mounts all three
 * together. What they genuinely share is the contract — every function resolves
 * rather than throws, and a failure is a STRING the page renders — because every
 * caller is a click handler that needs to branch, not a place to handle an
 * exception that has already been captured for display.
 *
 * =============================================================================
 * TWO READS, NOT ONE, AND THEY REFRESH TOGETHER BUT LOAD APART
 * =============================================================================
 *
 * The fleet and the credential list are separate endpoints answering separate
 * questions ("is every worker alive" / "which tokens exist"), and they are kept
 * on separate hooks so that neither can gate the other. That matters in the
 * exact situation this page exists for: if one combined hook loaded both and
 * `GET /admin/nodes` were slow or failing, the credential list — and with it
 * the revoke button, which is the incident-response action — would be behind
 * that spinner or that error banner. An operator who has just been told a
 * worker is compromised must not be waiting on a fleet query to cut its token
 * off.
 *
 * The PAGE then refreshes both from one callback, so the two halves are never
 * a poll apart.
 *
 * =============================================================================
 * WHY THE FLEET POLLS AND THE CREDENTIALS DO NOT
 * =============================================================================
 *
 * A node's health changes with nobody touching it — that is the entire content
 * of a heartbeat — so the fleet is polled, through the shared
 * `useVisiblePolling` (re-exported below; the one implementation lives in
 * `hooks/useVisiblePolling.ts`, extracted there by this issue rather than
 * copied). Credentials change only when a human creates or revokes one, and
 * both of those go through `useNodeActions`, which refreshes on success. A
 * timer over a list that cannot change on its own would be load with no
 * information in it.
 *
 * The poll refreshes the credential list anyway when the page asks it to,
 * because a SECOND administrator revoking a credential is a change this tab
 * did not make — but the page, not this module, decides that.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  createNodeCredential,
  deleteWorkerNode,
  getNodeCredentials,
  getWorkerNodes,
  revokeNodeCredential,
} from '../services/nodes';
import type {
  CreateNodeCredentialInput,
  NodeCredential,
  NodeCredentialCreated,
  WorkerNode,
} from '../services/nodes';
import { useIsMounted } from './useIsMounted';
import { useVisiblePolling } from './useVisiblePolling';

// One implementation, in `hooks/useVisiblePolling.ts` — see the file header.
export { useVisiblePolling };

/**
 * How often the fleet page re-asks, while its tab is in front.
 *
 * Ten seconds, matching `JOBS_POLL_INTERVAL_MS`, and chosen against what the
 * data can actually do rather than by symmetry: `nodes.staleHeartbeatSeconds`
 * is measured in tens of seconds at minimum, so a node cannot change health
 * faster than that, and a shorter poll would re-derive the same verdict against
 * a `groupBy` over the jobs table for nothing.
 */
export const WORKER_NODES_POLL_INTERVAL_MS = 10_000;

/**
 * Turn any thrown value into the sentence the page will render.
 *
 * 403 is named explicitly because its remedy is a permission rather than a
 * retry — the treatment `useJobs`, `useMaintenance` and `useEmailSettings` all
 * give it. The message says "worker nodes" and not "jobs", because the two are
 * genuinely different permissions (`nodes:read`/`nodes:write` versus
 * `jobs:read`/`jobs:write`) and telling an operator to ask for the wrong one is
 * worse than telling them nothing.
 */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to manage worker nodes';
    return err.message;
  }
  return fallback;
}

// =============================================================================
// The fleet
// =============================================================================

export interface UseWorkerNodesResult {
  nodes: WorkerNode[];
  isLoading: boolean;
  error: string | null;
  /** Re-read WITHOUT raising the loading flag. What the poll calls. */
  refresh: () => Promise<void>;
}

/**
 * `GET /api/admin/nodes`.
 *
 * NO PARAMETERS, because the endpoint takes none: it returns the whole fleet
 * ordered by name in one response. A filter argument here would be a promise
 * this hook could only keep by filtering client-side, which the DataTable
 * contract explicitly forbids a page from pretending to do.
 */
export function useWorkerNodes(): UseWorkerNodesResult {
  const [nodes, setNodes] = useState<WorkerNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it.
  const isMounted = useIsMounted();

  const load = useCallback(
    async (showLoading: boolean) => {
      // A POLL DOES NOT RAISE THE LOADING FLAG. The rows stay on screen and the
      // table keeps its scroll offset, its expansion and its focus; a spinner
      // every ten seconds over data that is already correct is the fastest way
      // to make a live table unusable.
      if (showLoading) setIsLoading(true);
      try {
        const data = await getWorkerNodes();
        if (isMounted()) {
          setNodes(data);
          setError(null);
        }
      } catch (err) {
        if (isMounted()) {
          setError(messageFor(err, 'Failed to load worker nodes'));
          // CLEARED, not left standing. Unlike a stats strip, these rows carry
          // a health verdict: leaving the last successful fleet on screen under
          // an error banner would show "healthy" pills for nodes nobody has
          // heard from since, which is the one wrong answer this page must
          // never give.
          setNodes([]);
        }
      } finally {
        if (isMounted() && showLoading) setIsLoading(false);
      }
    },
    [isMounted],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const refresh = useCallback(async () => {
    await load(false);
  }, [load]);

  return { nodes, isLoading, error, refresh };
}

// =============================================================================
// The credentials
// =============================================================================

export interface UseNodeCredentialsResult {
  credentials: NodeCredential[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * `GET /api/admin/nodes/credentials` — every credential in the deployment,
 * newest first, including revoked ones.
 *
 * On its own hook and its own request, for the reason in the file header: the
 * revoke button must not be gated behind the fleet query.
 */
export function useNodeCredentials(): UseNodeCredentialsResult {
  const [credentials, setCredentials] = useState<NodeCredential[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const load = useCallback(
    async (showLoading: boolean) => {
      if (showLoading) setIsLoading(true);
      try {
        const data = await getNodeCredentials();
        if (isMounted()) {
          setCredentials(data);
          setError(null);
        }
      } catch (err) {
        if (isMounted()) {
          setError(messageFor(err, 'Failed to load node credentials'));
          // Cleared for the same reason the fleet is: a stale list under an
          // error banner would show a credential as active after somebody else
          // revoked it, and this list's whole job is to answer "what can still
          // authenticate right now".
          setCredentials([]);
        }
      } finally {
        if (isMounted() && showLoading) setIsLoading(false);
      }
    },
    [isMounted],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const refresh = useCallback(async () => {
    await load(false);
  }, [load]);

  return { credentials, isLoading, error, refresh };
}

// =============================================================================
// The writes
// =============================================================================

export interface UseNodeActionsResult {
  /** True while any one of the three writes is in flight. */
  isWorking: boolean;
  /** The last failure, or `null`. Cleared when a write starts. */
  error: string | null;
  clearError: () => void;
  /** `true` when the node was deleted. Never throws. */
  removeNode: (id: string) => Promise<boolean>;
  /**
   * The created credential INCLUDING ITS RAW TOKEN, or `null` when the create
   * failed. The caller must show that token immediately — see below.
   */
  createCredential: (
    input: CreateNodeCredentialInput,
  ) => Promise<NodeCredentialCreated | null>;
  /** `true` when the credential was revoked. Never throws. */
  revokeCredential: (id: string) => Promise<boolean>;
}

/**
 * The three writes, sharing one in-flight flag and one error.
 *
 * ONE FLAG FOR ALL THREE, as `useJobActions` has one for its four: they all
 * mutate the same fleet and the page re-reads it after any of them, so a second
 * write started while the first is landing would be issued against state that
 * is already wrong, and its result would be reported over the top of the first
 * one's.
 *
 * =============================================================================
 * `createCredential` RETURNS THE TOKEN. IT IS NOT STORED HERE.
 * =============================================================================
 *
 * The raw `nod_…` token exists in exactly one response and can never be
 * fetched again. This hook hands it straight back to the caller and keeps NO
 * copy: holding it in state here would mean a secret living in a hook that
 * outlives the dialog showing it, surviving every re-render and every
 * subsequent action, for no benefit — the page needs it for exactly as long as
 * the reveal dialog is open, and that dialog's own state is the shortest
 * lifetime that works.
 *
 * `onChanged` fires AFTER the write resolves and never in parallel with it: a
 * refresh racing its own mutation is how a revoked credential flickers back to
 * "Active" for one frame.
 */
export function useNodeActions(onChanged?: () => void): UseNodeActionsResult {
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  // NOT held in a ref, unlike `useJobActions`'s equivalent. That hook's page
  // passes a fresh closure over its current filters on every render; this page
  // has no filters to close over and passes a `useCallback`, so depending on it
  // directly is honest and one less indirection.
  const run = useCallback(
    async <T,>(operation: () => Promise<T>, fallback: string): Promise<T | null> => {
      setIsWorking(true);
      setError(null);
      try {
        const result = await operation();
        onChanged?.();
        return result;
      } catch (err) {
        if (isMounted()) setError(messageFor(err, fallback));
        return null;
      } finally {
        if (isMounted()) setIsWorking(false);
      }
    },
    [isMounted, onChanged],
  );

  const removeNode = useCallback(
    async (id: string) =>
      (await run(async () => {
        await deleteWorkerNode(id);
        // `deleteWorkerNode` resolves `undefined` (the endpoint answers 204)
        // and `run` reports failure as `null`, so a literal is returned to keep
        // "succeeded" distinguishable from "failed".
        return true;
      }, 'Failed to delete worker node')) !== null,
    [run],
  );

  const createCredential = useCallback(
    (input: CreateNodeCredentialInput) =>
      run(() => createNodeCredential(input), 'Failed to create node credential'),
    [run],
  );

  const revokeCredential = useCallback(
    async (id: string) =>
      (await run(async () => {
        await revokeNodeCredential(id);
        return true;
      }, 'Failed to revoke node credential')) !== null,
    [run],
  );

  const clearError = useCallback(() => setError(null), []);

  return { isWorking, error, clearError, removeNode, createCredential, revokeCredential };
}
