import type { SxProps, Theme } from '@mui/material/styles';

/**
 * The styles of a visually hidden element that screen readers still announce.
 *
 * @remarks
 * The same declarations as `@mui/utils`' `visuallyHidden`, written out so the
 * slice does not import a package that is not one of its peers.
 */
export const visuallyHidden: SxProps<Theme> = {
  border: 0,
  clipPath: 'inset(50%)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
};
