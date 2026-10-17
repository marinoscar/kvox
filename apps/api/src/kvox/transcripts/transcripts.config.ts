// FIRST: sets how the routes are documented before `forRoot` documents them.
import '../auth-documenter';

import { TranscriptsModule } from '@marinoscar/kvox-api/transcripts';

import { sharingModule } from '../../platform/sharing/sharing.config';
import { SearchIndexingConfig } from '../search/search.config';
import { TranscriptionConfig } from '../transcription/transcription.config';
import { PlatformTranscriptSharing } from './platform-transcript-sharing';

// =============================================================================
// The web edition's configuration of the transcripts slice (issue #493, epic #491)
// =============================================================================
//
// The only place this application configures `@marinoscar/kvox-api/transcripts`.
// Everything else the slice needs comes from the ports `PlatformKvoxModule` binds
// (database, object store, jobs, notifications, events, audit, AI, settings, secrets,
// identity, brand).
//
//   sharing    who else may open a transcript: the platform sharing slice
//              (`PlatformTranscriptSharing`, over `AccessPolicy` and `GrantsService`).
//              The platform's sharing module is not global, so it is imported here for the
//              providers that class injects.
//   peers      the transcription and search-indexing modules the slice imports for the
//              providers they export: the SAME objects `KvoxModule` imports, so each is one
//              module. Handlers register once.
//   appUrl     the absolute URL of the application root, for a notification's button. Read
//              when a message is built, from the same variable the email slice reads.
//   exporters / pdf / media / schedules / playbackUrlTtlSeconds / staleUploadHours:
//              the slice's defaults. The housekeeping cron is on (the platform runs
//              `ScheduleModule`); the playback URL lives six hours; an upload idle for the
//              storage slice's 72 hours is stale; ffmpeg is on the PATH.
//
// What stays out of the slice and lives beside this file, because it uses the platform:
// the onboarding step and facts (`transcripts.onboarding.ts`), the notification
// registrations (`notification-templates.ts`) and the sharing implementation. (The bridge from the
// slice's event port to the application's `@OnEvent` listeners is gone: the graph subscribes to the
// event port itself since #496.) The permissions the slice exports as data are
// registered in `app-registrations/kvox-permissions.ts`; the email templates stay in
// `email-templates/`.
//
// Exported as a constant because other modules (notes, graph, Ask) import it: a dynamic module built twice with the same options is one
// module, but one constant is the unmistakable way to say so.
// =============================================================================

const DEFAULT_APP_URL = 'http://localhost:3535';

export const TranscriptsConfig = TranscriptsModule.forRoot({
  sharing: PlatformTranscriptSharing,
  imports: [sharingModule],
  peers: { transcription: TranscriptionConfig, searchIndexing: SearchIndexingConfig },
  appUrl: () => process.env.APP_URL || DEFAULT_APP_URL,
});
