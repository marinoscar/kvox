import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

/**
 * A centred spinner for a page that is loading.
 *
 * @param props - `size` in pixels (default 40).
 * @returns The spinner block.
 *
 * @stability experimental
 */
export function KvoxLoadingSpinner({ size = 40 }: { size?: number }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
      <CircularProgress size={size} />
    </Box>
  );
}
