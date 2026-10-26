/**
 * The "Possible duplicates" entry point (#766) on the Knowledge index and the
 * Review Queue: a link to `/graph/duplicates` with the number of pairs waiting.
 *
 * ONE CHEAP REQUEST: `GET /api/graph/duplicates?limit=50`; a full page reads
 * "50+". A failure only hides the count, never the link.
 */

import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import type { ButtonProps } from '@mui/material/Button';
import { Link as RouterLink } from 'react-router-dom';

/**
 * How many pairs the entry points ask for; a full answer reads "50+".
 *
 * @stability experimental
 */
export const DUPLICATES_BADGE_LIMIT = 50;

/**
 * The badge text for a count: `null` for none, "50+" at the limit.
 *
 * @stability experimental
 */
export function duplicatesBadgeText(count: number): string | null {
  if (count <= 0) return null;
  return count >= DUPLICATES_BADGE_LIMIT ? `${DUPLICATES_BADGE_LIMIT}+` : String(count);
}

/**
 * Props of {@link DuplicatesLink}.
 *
 * @stability experimental
 */
export interface DuplicatesLinkProps {
  /** The number of pairs (from `useGraphDuplicates({ limit: 50 })`); `0` draws no badge. */
  count: number;
  /** The button's variant; default `outlined`. */
  variant?: ButtonProps['variant'];
  /** The button's size. */
  size?: ButtonProps['size'];
}

/**
 * A button linking to `/graph/duplicates` with the count as a badge.
 *
 * @stability experimental
 */
export function DuplicatesLink({ count, variant = 'outlined', size }: DuplicatesLinkProps) {
  const badge = duplicatesBadgeText(count);
  return (
    <Button
      component={RouterLink}
      to="/graph/duplicates"
      variant={variant}
      size={size}
      aria-label={badge ? `Possible duplicates (${badge})` : 'Possible duplicates'}
      endIcon={
        badge ? (
          <Chip
            size="small"
            color="warning"
            label={badge}
            aria-hidden="true"
            data-testid="duplicates-badge"
            sx={{ height: 20, '& .MuiChip-label': { px: 0.75 } }}
          />
        ) : undefined
      }
      sx={{ whiteSpace: 'nowrap' }}
    >
      Possible duplicates
    </Button>
  );
}
