import { lazy } from 'react';
import { kvoxTranscriptsRoutes } from '@marinoscar/kvox-web/transcripts/ui';
import type { KvoxRouteDef } from '@marinoscar/kvox-web/core/ui';

const TranscriptsPageWithSlots = lazy(() =>
  import('./TranscriptsPageWithSlots').then((m) => ({ default: m.TranscriptsPageWithSlots })),
);
const TranscriptPageWithSlots = lazy(() =>
  import('./TranscriptPageWithSlots').then((m) => ({ default: m.TranscriptPageWithSlots })),
);

/**
 * The transcripts routes of `@marinoscar/kvox-web`, with the two pages that take
 * slots swapped for this app's wrappers. Same paths, same permissions, same
 * order; the other two pages (`/transcripts/new`, `.../history`) take none.
 * Issue #500, epic #498.
 */
export const appTranscriptsRoutes: readonly KvoxRouteDef[] = kvoxTranscriptsRoutes.map((route) => {
  if (route.path === '/transcripts') return { ...route, Component: TranscriptsPageWithSlots };
  if (route.path === '/transcripts/:id') return { ...route, Component: TranscriptPageWithSlots };
  return route;
});
