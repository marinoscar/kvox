/**
 * Performance budgets of the explorer (GIC-08, #669; epic #661), one place so
 * the canvas (GIC-06 layout, GIC-07, GIC-09 minimap) and the model read the
 * same numbers.
 *
 * | Budget                 | Compact or coarse pointer | Else            |
 * |------------------------|---------------------------|-----------------|
 * | Visible node cap       | 120                       | 300             |
 * | Layout time box        | 1.5 s                     | 3 s             |
 * | `devicePixelRatio` cap | 2                         | native          |
 * | `hideEdgesOnMove`      | above 500 edges           | above 1,000     |
 * | Label density          | reduced                   | default         |
 *
 * "Constrained" is a compact WINDOW or a coarse POINTER: a large tablet is as
 * constrained as a phone, and a narrowed desktop window is not.
 */

import { EXPLORER_NODE_CAP } from '../explorerModel.js';
import type { InputModality } from './useInputModality.js';
import type { WindowClass } from './useWindowClass.js';

/** Visible node cap on a compact window or coarse pointer. */
export const COMPACT_NODE_CAP = 120;
/** Layout time box (ms) on a compact window or coarse pointer. */
export const COMPACT_LAYOUT_TIME_BOX_MS = 1500;
/** Layout time box (ms) elsewhere. */
export const DEFAULT_LAYOUT_TIME_BOX_MS = 3000;
/** `devicePixelRatio` cap on a compact window or coarse pointer. */
export const COMPACT_PIXEL_RATIO_CAP = 2;
/** Edge count above which edges are hidden while the camera moves, constrained. */
export const COMPACT_HIDE_EDGES_ON_MOVE_ABOVE = 500;
/** Edge count above which edges are hidden while the camera moves, elsewhere. */
export const DEFAULT_HIDE_EDGES_ON_MOVE_ABOVE = 1000;
/** Smallest hit target (CSS px) on a coarse pointer. */
export const COARSE_HIT_TARGET_PX = 44;
/** Sigma `labelDensity` per label-density budget. */
export const LABEL_DENSITY = { reduced: 0.35, default: 1 } as const;

/**
 * The budgets in force for one window class and input modality.
 *
 * @stability experimental
 */
export interface ExplorerBudgets {
  /** `true` on a compact window or with a coarse pointer. */
  constrained: boolean;
  /** Most nodes the explorer shows at once; the cap `expand` and the CapWarning use. */
  visibleNodeCap: number;
  /** Longest a layout settle may run, in ms. */
  layoutTimeBoxMs: number;
  /** Cap on sigma's `devicePixelRatio`, or `null` for the native one. */
  pixelRatioCap: number | null;
  /** Edge count above which edges are hidden while the camera moves. */
  hideEdgesOnMoveAbove: number;
  /** `reduced` draws fewer labels. */
  labelDensity: 'reduced' | 'default';
  /** Smallest hit target in CSS px, drawn as an enlarged pick radius; 0 for the default. */
  hitTargetPx: number;
  /** Visible nodes above which the list view is the default (compact windows only). */
  listViewDefaultAbove: number;
}

/** Budgets of a compact window. */
export const COMPACT_BUDGETS: ExplorerBudgets = {
  constrained: true,
  visibleNodeCap: COMPACT_NODE_CAP,
  layoutTimeBoxMs: COMPACT_LAYOUT_TIME_BOX_MS,
  pixelRatioCap: COMPACT_PIXEL_RATIO_CAP,
  hideEdgesOnMoveAbove: COMPACT_HIDE_EDGES_ON_MOVE_ABOVE,
  labelDensity: 'reduced',
  hitTargetPx: COARSE_HIT_TARGET_PX,
  listViewDefaultAbove: COMPACT_NODE_CAP,
};

/** Budgets of a roomy window with a precise pointer. */
export const DEFAULT_BUDGETS: ExplorerBudgets = {
  constrained: false,
  visibleNodeCap: EXPLORER_NODE_CAP,
  layoutTimeBoxMs: DEFAULT_LAYOUT_TIME_BOX_MS,
  pixelRatioCap: null,
  hideEdgesOnMoveAbove: DEFAULT_HIDE_EDGES_ON_MOVE_ABOVE,
  labelDensity: 'default',
  hitTargetPx: 0,
  listViewDefaultAbove: Number.POSITIVE_INFINITY,
};

/**
 * The budgets for a window class and an input modality.
 *
 * @stability experimental
 */
export function explorerBudgets(input: {
  windowClass: WindowClass;
  inputModality: InputModality;
}): ExplorerBudgets {
  if (input.windowClass === 'compact') return COMPACT_BUDGETS;
  if (input.inputModality === 'touch') {
    // A large tablet: as constrained as a phone, but its window is roomy enough for the graph at any size.
    return { ...COMPACT_BUDGETS, listViewDefaultAbove: Number.POSITIVE_INFINITY };
  }
  return DEFAULT_BUDGETS;
}
