/**
 * Layout tuning constants (GIC-07, #668).
 *
 * @remarks
 * The layout TIME BOX is not here: it is `explorerBudgets(...).layoutTimeBoxMs`
 * (`shell/explorerBudgets.ts`, GIC-08), the one place the explorer's budgets
 * live. The G6 layout options themselves are `canvasLayouts.ts`.
 */

/** An ego view smaller than this opens in the concentric layout. */
export const CONCENTRIC_EGO_MAX_NODES = 40;
