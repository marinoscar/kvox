import { Module } from '@nestjs/common';

import { AiModule } from '../../ai/ai.module';
import { JobsModule } from '../../jobs/jobs.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { SearchIndexHandler } from './search-index.handler';
import { SearchIndexService } from './search-index.service';

// =============================================================================
// SearchIndexingModule (issue #188, epic #165 — Semantic Search)
// =============================================================================
//
// The `search.index` job type and the two-verb surface its enqueue points talk
// to. One class, self-registered from `onModuleInit`, exactly as
// `handlers/README.md` describes — nothing in the worker, the claim query, the
// enqueue service or the admin dashboard is touched by adding it.
//
// -----------------------------------------------------------------------------
// WHY THIS MODULE EXISTS RATHER THAN A `SearchModule`
// -----------------------------------------------------------------------------
//
// There is no `SearchModule` in this repository yet. `apps/api/src/search/`
// currently holds `chunking/`, which is deliberately NOT a Nest module at all —
// its header states the rule: plain pure functions, no `@Injectable`, no DI,
// because a chunker one constructor parameter away from holding a repository is
// a chunker whose output can stop being a function of its input. So this issue
// creates the first module under `search/`, scoped to INDEXING specifically
// rather than claiming the whole namespace, and the query side of epic #165
// gets its own when it lands. A `SearchModule` that owned both would make the
// retrieval path import the embedding path's provider graph for no reason.
//
// -----------------------------------------------------------------------------
// THE DEPENDENCY DIRECTION IS ONE-WAY, AND THAT IS WHAT KEEPS IT ACYCLIC
// -----------------------------------------------------------------------------
//
// This module imports `PrismaModule`, `JobsModule` and `AiModule`, and NEITHER
// `TranscriptsModule` NOR `NotesModule` — it reads both documents' rows through
// Prisma directly rather than through their services, precisely so those two
// can import this one. `TranscriptsModule`, `NotesModule` and `UserDataModule`
// each import it to reach `SearchIndexService`; nothing here reaches back, so
// there is no `forwardRef` anywhere in this epic and there should not be one.
//
// The handler needs `AiModule`'s three exports (`AiProviderRegistry`,
// `AiSettingsService`, `UserAiCredentialsService`) and nothing new from it: the
// resolution it performs — deployment policy, active provider, the OWNER's own
// key — is the one `NoteGenerateHandler` already performs, reached through the
// same services.
// =============================================================================

@Module({
  imports: [PrismaModule, JobsModule, AiModule],
  providers: [SearchIndexHandler, SearchIndexService],
  // Only the service. `SearchIndexHandler` is reached by the worker through
  // `JobHandlerRegistry`, never by injection, so exporting it would advertise a
  // seam nobody may use — and would let a caller invoke `process` directly,
  // outside the lease, the attempt budget and the timeout that make it safe.
  exports: [SearchIndexService],
})
export class SearchIndexingModule {}
