// FIRST: sets how the routes are documented before `forRoot` documents them.
import '../auth-documenter';

import { NotesModule } from '@marinoscar/kvox-api/notes';

import { SearchIndexingConfig } from '../search/search.config';
import { TranscriptsConfig } from '../transcripts/transcripts.config';

// =============================================================================
// The web edition's configuration of the notes slice (issue #495, epic #491)
// =============================================================================
//
// The only place this application configures `@marinoscar/kvox-api/notes`. Everything else
// the slice needs comes from the ports `PlatformKvoxModule` binds (database, object store,
// jobs, notifications, events, audit, AI, settings, identity, brand).
//
//   peers      the transcripts and search-indexing modules the slice imports for the
//              providers they export: the SAME objects `KvoxModule` imports, so each is one
//              module and its handlers register once. The slice never provides them again.
//   appUrl     the absolute URL of the application root, for a notification's button. Read when
//              a message is built, from the same variable the email slice reads.
//   exporters / documentSources / schedules / stream: the slice's defaults. All three
//              exporters are on, PDF and text documents can be sources, the housekeeping cron
//              is on (the platform runs `ScheduleModule`) and the stream keeps its cadence.
//
// What stays out of the slice and lives beside this file, because it uses the platform: the
// onboarding step and fact (`notes.onboarding.ts`), the notification registrations
// (`notification-templates.ts`), the Danger Zone categories (`user-data.ts`) and the TEMPORARY
// listener that hands a ready note to the graph (`graph/extraction/note-ready-auto-extract.listener.ts`,
// provided by `GraphExtractionModule`). The permissions
// the slice exports as data are registered in `app-registrations/kvox-permissions.ts`; the
// email templates stay in `email-templates/`.
//
// Exported as a constant because other modules (the graph and Ask, until they move into the
// package) import it: a dynamic module built twice with the same options is one module, but
// one constant is the unmistakable way to say so.
// =============================================================================

const DEFAULT_APP_URL = 'http://localhost:3535';

export const NotesConfig = NotesModule.forRoot({
  peers: { transcripts: TranscriptsConfig, searchIndexing: SearchIndexingConfig },
  appUrl: () => process.env.APP_URL || DEFAULT_APP_URL,
});
