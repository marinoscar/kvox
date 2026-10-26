/**
 * The "Synonyms" entry point (#767) on the Possible duplicates page: a link to
 * `/graph/synonyms`, the caller's personal synonym groups. No request: the
 * link is always drawn for a caller who can read the graph.
 */

import Button from '@mui/material/Button';
import type { ButtonProps } from '@mui/material/Button';
import { Link as RouterLink } from 'react-router-dom';

/**
 * Props of {@link SynonymsLink}.
 *
 * @stability experimental
 */
export interface SynonymsLinkProps {
  /** The button's variant; default `outlined`. */
  variant?: ButtonProps['variant'];
  /** The button's size. */
  size?: ButtonProps['size'];
}

/**
 * A button linking to `/graph/synonyms`.
 *
 * @stability experimental
 */
export function SynonymsLink({ variant = 'outlined', size }: SynonymsLinkProps) {
  return (
    <Button component={RouterLink} to="/graph/synonyms" variant={variant} size={size} sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
      Synonyms
    </Button>
  );
}
