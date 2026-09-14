/**
 * What the home page looks like before `GET /api/transcripts/summary` answers.
 * Issue #32, epic #19.
 *
 * A SKELETON RATHER THAN A SPINNER, and the difference matters most on the
 * surface it is used on. This page is the app's landing screen: it is rendered
 * on every cold start, every PWA launch and every return from the OS task
 * switcher, so its loading state is the single most-seen frame in the product.
 * A centred spinner throws the whole layout away and rebuilds it a moment
 * later, which on a phone reads as a page that flickers; blocks of the right
 * size in the right places mean the content lands INTO the shape already on
 * screen instead of replacing it.
 *
 * The block count mirrors the real thing loosely rather than exactly — four
 * cards, not eight — because the skeleton must not imply a number the answer
 * may contradict. Guessing eight and rendering two is a worse flicker than the
 * one this file exists to remove.
 *
 * `role="status"` + `aria-busy`, not `role="progressbar"`: there is no
 * measurable progress here, and a screen reader announcing an unlabelled,
 * value-less progress bar on every visit is noise rather than information.
 * The role is load-bearing rather than decorative — `aria-label` on a bare
 * `div` is an axe `aria-prohibited-attr` failure, because a nameless generic
 * element has nothing for a name to attach to. `status` also carries an
 * implicit `aria-live="polite"`, so that attribute is deliberately absent.
 */

import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';

export function HomeSkeleton() {
  return (
    <Box role="status" aria-busy="true" aria-label="Loading your transcripts">
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ justifyContent: 'space-between', mb: { xs: 3, sm: 4 } }}
      >
        <Box sx={{ width: '100%' }}>
          <Skeleton variant="text" width={220} height={44} />
          <Skeleton variant="text" width={180} />
        </Box>
        <Skeleton
          variant="rounded"
          height={42}
          sx={{ width: { xs: '100%', sm: 170 }, flexShrink: 0 }}
        />
      </Stack>

      <Skeleton variant="text" width={120} height={32} sx={{ mb: 1.5 }} />
      <Grid container spacing={1.5}>
        {[0, 1, 2, 3].map((index) => (
          <Grid key={index} size={{ xs: 12, sm: 6, md: 4, lg: 3 }}>
            <Skeleton variant="rounded" height={116} />
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}

export default HomeSkeleton;
