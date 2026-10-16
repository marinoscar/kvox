import type { OnboardingFactDef } from '@marinoscar/platform-api/onboarding';

import { KVOX_AI, type KvoxAi } from '../../ai-port/kvox-ai';

// =============================================================================
// This app's onboarding facts (issue #481, epic #478)
// =============================================================================
//
// A fact is the ONLY read an onboarding step may depend on: the engine resolves each
// one at most once per request, in parallel, before any step runs, and a step's
// `evaluate` receives plain values. A fact that rejects omits the steps that name it
// (one logged warning); it never fails the response.
//
// Ids are `app.<name>` and are not persisted anywhere (only STEP ids are), but a
// step's `facts` array names them, so a rename is a two-file change that
// `assertOnboardingRegistries` checks at boot.
//
// Every fact reads through the service that already owns the question, never a second
// derivation of it: a checklist that answered "can this deployment transcribe" itself
// would eventually disagree with the upload button.
//
// WHERE THE FACTS LIVE. The ids are spelled once, here. The AI readiness fact is base code
// (`ai-port/` is base) and is declared here. The facts that read domain data are declared
// beside their domain and registered by `kvox.manifest.ts`, because base code may not import
// domain code (`test/architecture/base-domain-boundary.spec.ts`):
//
//   app.transcriptionAvailable        transcription/transcription.onboarding.ts
//   app.ownTranscriptCount            transcripts/transcripts.onboarding.ts
//   app.ownReadyTranscriptCount       transcripts/transcripts.onboarding.ts
//   app.ownNoteCount                  notes/notes.onboarding.ts
// =============================================================================

/** The fact ids, spelled once. */
export const KVOX_ONBOARDING_FACTS = {
  /** `boolean`: this deployment can transcribe at all. */
  TRANSCRIPTION_AVAILABLE: 'app.transcriptionAvailable',
  /** `number`: transcripts the caller owns that are not soft-deleted. */
  OWN_TRANSCRIPT_COUNT: 'app.ownTranscriptCount',
  /** `number`: transcripts the caller owns that reached `ready` (not soft-deleted). */
  OWN_READY_TRANSCRIPT_COUNT: 'app.ownReadyTranscriptCount',
  /** `number`: notes the caller owns that are not soft-deleted. */
  OWN_NOTE_COUNT: 'app.ownNoteCount',
  /** {@link KvoxAiOnboardingReadiness}: the AI readiness of the caller. */
  AI_READINESS: 'app.aiReadiness',
} as const;

/** What `app.aiReadiness` resolves to. */
export interface KvoxAiOnboardingReadiness {
  /**
   * Usable by this caller, or usable once they add a key: the deployment has AI on, the
   * provider slot on and at least one model enabled. The caller's own key is a separate
   * question (`hasKey`).
   */
  available: boolean;
  /** The caller has stored their own key. */
  hasKey: boolean;
  /** AI is on and the provider slot is on: a key could be saved now. */
  providerSet: boolean;
}

/**
 * `KvoxAi.readiness(caller, 'note_generate')` reduced to what the steps read. Never throws
 * (the port's contract), so a broken AI configuration reads as "not available", not as a
 * missing step.
 */
export const AI_READINESS_FACT: OnboardingFactDef<KvoxAiOnboardingReadiness> = {
  id: KVOX_ONBOARDING_FACTS.AI_READINESS,
  resolve: async (ctx) => {
    const readiness = await ctx.get<KvoxAi>(KVOX_AI).readiness(ctx.caller.id, 'note_generate');
    return {
      available: readiness.ok || readiness.reason === 'ai_key_missing',
      hasKey: readiness.hasKey,
      providerSet: readiness.provider !== null,
    };
  },
};

/** The facts the base steps need. The domain folders declare the rest (see the header). */
export const KVOX_BASE_ONBOARDING_FACT_DEFS: readonly OnboardingFactDef[] = [AI_READINESS_FACT];
