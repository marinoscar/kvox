/** The entity page's first-load placeholder (#373): header, brief, list. */

import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';

export function EntityPageSkeleton() {
  return (
    <Box role="status" aria-busy="true" aria-label="Loading this page">
      <Skeleton variant="rounded" width={90} height={24} sx={{ mb: 1 }} />
      <Skeleton variant="text" width="45%" height={48} />
      <Skeleton variant="text" width="60%" />
      <Skeleton variant="rounded" height={220} sx={{ mt: 3, mb: 3 }} />
      <Skeleton variant="text" width="30%" height={32} />
      <Skeleton variant="text" width="70%" />
      <Skeleton variant="text" width="55%" />
    </Box>
  );
}

export default EntityPageSkeleton;
