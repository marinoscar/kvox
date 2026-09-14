import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TranscriptsModule } from '../transcripts/transcripts.module';
import { NoteGenerationService } from './generation/note-generation.service';
import { NoteSourceService } from './generation/note-source.service';
import { NoteGenerateHandler } from './handlers/note-generate.handler';

// =============================================================================
// NotesModule (issue #49, epic #45)
// =============================================================================
//
// The generation pipeline, and for now nothing else: #53 adds the controllers,
// #54 the exporters, #51 the document extraction. This module exists as soon as
// there is a handler to register, because a handler that no module provides is
// a class Nest never instantiates — and `onModuleInit` is where every handler in
// this codebase registers itself.
//
// WHAT IT IMPORTS, AND WHY EACH ONE:
//
//   • `PrismaModule` — the note, generation, template and version rows.
//   • `JobsModule` — `JobHandlerRegistry` for `note.generate` to register with,
//     and `ProviderThrottleService` for the PER-USER rate-limit bucket (spec
//     §2.3). `JobsService` joins when #53 starts enqueueing.
//   • `AiModule` — the provider registry, the deployment policy, and
//     `UserAiCredentialsService`, which is the only way to reach a user's own
//     decrypted key. That module is deliberately NOT `@Global()` precisely so
//     this import shows up in a diff.
//   • `NotificationsModule` — the two owner-addressed events.
//   • `TranscriptsModule` — `TranscriptMaterializeService` and the Markdown
//     exporter. ⚠ THIS IMPORT IS THE POINT OF THE EPIC: a note is generated
//     from the transcript AS THE USER CORRECTED IT, which means going through
//     the transcript module's own materialization rather than reading its
//     tables sideways. See `NoteSourceService`'s header.
//
// Nothing is exported yet. A service exported before anybody imports it is a
// public API nobody asked for — the same discipline `TranscriptsModule` states
// for itself.
// =============================================================================

@Module({
  imports: [
    PrismaModule,
    JobsModule,
    AiModule,
    NotificationsModule,
    TranscriptsModule,
  ],
  providers: [NoteGenerationService, NoteSourceService, NoteGenerateHandler],
})
export class NotesModule {}
