/**
 * `CapWarning` — the explorer's 300-node limit, NAMED (#374; spec §22.2:
 * past the cap, expansion is refused with a message naming it, never silently
 * degraded). Shown when an expand was refused, a merge dropped nodes at the
 * cap, or the last slice had more than it returned. Dismissible; it comes
 * back on the next refusal.
 */

import Alert from '@mui/material/Alert';

import { EXPLORER_NODE_CAP } from './explorerModel.js';

/** The warning for a given cap: the explorer's own on a roomy window, the smaller budget on a phone or a coarse pointer (GIC-08). */
export function capWarningText(cap: number): string {
  return `Showing ${cap} nodes — the limit for the explorer. Hide nodes or narrow the filters to see more.`;
}
export const CAP_WARNING_TEXT = capWarningText(EXPLORER_NODE_CAP);
export const TRUNCATED_WARNING_TEXT =
  'There is more connected here than one expansion returns. Hide nodes or narrow the filters to see more.';

export interface CapWarningProps {
  /** At the cap (refused or dropped). */
  capped: boolean;
  /** The last slice was truncated. */
  truncated: boolean;
  /** The cap in force; defaults to `EXPLORER_NODE_CAP`. */
  cap?: number;
  onDismiss: () => void;
}

export function CapWarning({ capped, truncated, cap = EXPLORER_NODE_CAP, onDismiss }: CapWarningProps) {
  if (!capped && !truncated) return null;
  return (
    <Alert severity="warning" role="status" onClose={onDismiss} sx={{ mb: 1.5 }}>
      {capped ? capWarningText(cap) : TRUNCATED_WARNING_TEXT}
    </Alert>
  );
}
