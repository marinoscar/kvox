// FIRST: sets how the routes are documented before `forRoot` documents them.
import '../auth-documenter';

import { AskModule } from '@marinoscar/kvox-api/ask';

import { GraphConfig } from '../graph/graph.config';
import { NotesConfig } from '../notes/notes.config';
import { SearchConfig } from '../search/search.config';

// =============================================================================
// The web edition's configuration of the Ask slice (issue #497, epic #491)
// =============================================================================
//
// The only place this application configures `@marinoscar/kvox-api/ask`. Everything else the slice
// needs comes from the ports `PlatformKvoxModule` binds (database, jobs, audit, identity, AI,
// settings).
//
//   peers    the graph, notes and search modules the agent reads through: the SAME objects
//            `KvoxModule` imports, so each is one module and its handlers register once.
//   limits   the product's own caps (8 tool steps, 4 calls a step, a 4-minute soft clock). A host may
//            only LOWER them; this deployment keeps them.
//   stream   the slice's pacing (a read every 250 ms, a heartbeat every 25 s).
//
// What stays out of the slice and lives beside this file, because it uses the platform: the Danger
// Zone's `ask` category and model hint (`user-data.ts`). Ask has no permissions of its own (every route
// is `graph:read`) and no settings.
// =============================================================================

export const AskConfig = AskModule.forRoot({
  peers: { graph: GraphConfig, notes: NotesConfig, search: SearchConfig },
});
