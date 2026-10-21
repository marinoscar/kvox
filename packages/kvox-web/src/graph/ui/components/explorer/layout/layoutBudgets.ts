/**
 * Layout time boxes and tuning constants (GIC-07, #668).
 *
 * @remarks
 * Deliberately a small module of its own: the responsive shell story (#669) is
 * expected to replace these with its `explorerBudgets`. Nothing here depends on
 * that story; the layout code reads only this file.
 */

/** Time box of a layout run on a compact or coarse-pointer device, in milliseconds. */
export const LAYOUT_BUDGET_COARSE_MS = 1500;

/** Time box of a layout run everywhere else, in milliseconds. */
export const LAYOUT_BUDGET_DEFAULT_MS = 3000;

/** The time box for a device class. */
export function layoutBudgetMs(coarse: boolean): number {
  return coarse ? LAYOUT_BUDGET_COARSE_MS : LAYOUT_BUDGET_DEFAULT_MS;
}

/**
 * ForceAtlas2 iterations of one run: a FIXED count, so the same graph settles to
 * the same picture however fast the machine is. The time box only cuts it short.
 */
export const FA2_SETTLE_ITERATIONS = 180;

/**
 * Iterations per `graphology-layout-forceatlas2` call. FA2 keeps its swing and
 * traction state only inside one call, so the chunk size is part of the maths:
 * the worker and the main-thread fallback must use the same one to agree.
 */
export const FA2_CHUNK_ITERATIONS = 2;

/** Above this many nodes the run switches on Barnes-Hut approximation. */
export const BARNES_HUT_THRESHOLD = 1000;

/** Maximum noverlap passes of the final overlap removal. */
export const NOVERLAP_MAX_ITERATIONS = 50;

/** Duration of the position tween, in milliseconds. */
export const LAYOUT_TWEEN_MS = 300;

/** Main-thread fallback: how long one animation frame may spend laying out. */
export const FALLBACK_SLICE_MS = 8;

/** Worker: how long it computes between two progress frames. */
export const WORKER_SLICE_MS = 16;

/** An ego view smaller than this opens in the concentric layout. */
export const CONCENTRIC_EGO_MAX_NODES = 40;
