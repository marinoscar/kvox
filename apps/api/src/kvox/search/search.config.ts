// FIRST: sets how the routes are documented before `forRoot` documents them.
import '../auth-documenter';

import { SearchIndexingModule, SearchModule, type SemanticReason } from '@marinoscar/kvox-api/search';
import { APP_SLUG } from '@app/shared';
import { trace } from '@opentelemetry/api';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import { KVOX_EMBEDDING } from '../../ai-port/embedding-catalog';
import { SharedTranscriptVisibility } from './shared-transcript-visibility';

// =============================================================================
// The web edition's configuration of the search slice (issue #494, epic #491)
// =============================================================================
//
// The only place this application configures `@marinoscar/kvox-api/search`.
// Everything else the slice needs comes from the ports `PlatformKvoxModule` binds
// (database, AI, jobs, identity).
//
//   semantic.provider        `openai`, the provider that serves the embeddings model
//                            (`ai-port/embedding-catalog.ts`). It names the semantic axis
//                            of a cursor's fingerprint with the model the port reports,
//                            exactly as before the slice moved, so a cursor minted before
//                            a deploy stays valid across it.
//   semantic.onSemanticOff   records WHY the vector arm did not run as the span attribute
//                            `<app slug>.search.semantic_reason` on the request's span (a
//                            label value, never a metric label).
//   transcriptVisibility     owned or shared with the caller (`SharedTranscriptVisibility`).
//                            Notes are not shareable and have no such point.
//   typePermissions          the exact strings the transcripts and notes controllers enforce.
//   batchSize                the embeddings provider's batch ceiling, 128.
//
// Both modules are exported as constants because other modules (graph and Ask, until
// they move into the package; the transcripts and notes modules for the indexing half)
// import them: a dynamic module built twice with the same options is one module, but
// one constant is the unmistakable way to say so.
// =============================================================================

/** Records the reason the semantic arm is off on the active span. */
function recordSemanticReason(reason: SemanticReason): void {
  trace.getActiveSpan()?.setAttribute(`${APP_SLUG}.search.semantic_reason`, reason);
}

export const SearchConfig = SearchModule.forRoot({
  semantic: { provider: KVOX_EMBEDDING.provider, onSemanticOff: recordSemanticReason },
  transcriptVisibility: SharedTranscriptVisibility,
  typePermissions: {
    transcript: PERMISSIONS.TRANSCRIPTS_READ,
    note: PERMISSIONS.NOTES_READ,
  },
});

export const SearchIndexingConfig = SearchIndexingModule.forRoot({
  batchSize: KVOX_EMBEDDING.maxBatchSize,
});
