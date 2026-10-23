import { lazy } from 'react';

import type { KvoxRouteDef } from '../../core/ui/index.js';

/**
 * The Home route as data, for `renderKvoxRoutes`: `/`, open to every signed-in person.
 *
 * @remarks
 * It draws the knowledge-first Home (#721): `<KvoxHomePage>` with
 * `KVOX_KNOWLEDGE_HOME_SECTIONS` (Ask, the Review Queue, the note libraries, the
 * graph and the recent imports, then the journey, what is moving, what failed and
 * the recent notes; no transcripts). A host that fills a slot (`heroActions`,
 * `extraSteps`, `sections`) mounts `KvoxHomePage` itself in a `<Route path="/">`
 * and does not spread this; KVox web does, with the classic sections.
 *
 * @stability experimental
 */
export const kvoxHomeRoutes: readonly KvoxRouteDef[] = [
  {
    path: '/',
    Component: lazy(() =>
      import('./KnowledgeHomePage.js').then((module) => ({ default: module.KnowledgeHomePage })),
    ),
  },
];
