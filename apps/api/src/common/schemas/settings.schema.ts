// =============================================================================
// KVox's own settings schemas (issue #466, epic #462)
// =============================================================================
//
// What used to live here (the composed `userSettingsSchema`, `systemSettingsSchema`
// and their PATCH forms, the core namespaces' schemas, `theme` and `profile`) is
// the PLATFORM's since #466: `@marinoscar/platform-api/settings` composes the
// documents from the namespace registries (`settings/registry/`), and the
// platform slices export their own namespace schemas and value types
// (`@marinoscar/platform-contract/{jobs,nodes,db-backup,notifications,settings}`,
// `@marinoscar/platform-api/host`).
//
// Only KVox's own namespaces keep schemas in this repo:
//   transcription  transcription/transcription-settings.schema.ts
//   ai             ai/ai-settings.schema.ts   (re-exported below)
//   graph          graph/preferences/graph-preferences.schema.ts
//   onboarding     common/schemas/user-settings-namespaces.schema.ts
// =============================================================================

/**
 * AI policy (`ai`) — issue #47, epic #45.
 *
 * DEFINED IN `ai/ai-settings.schema.ts` AND RE-EXPORTED HERE: the shape has a
 * nested per-provider block and it carries a COMPILE-TIME PROOF that no
 * secret-bearing field exists, and a proof has to live next to the thing it
 * proves something about. That file imports nothing but zod, so it is a leaf
 * and this import cannot cycle.
 *
 * ⚠ THERE IS NO AI KEY ANYWHERE IN THIS ROW, AND UNLIKE `transcription` THERE
 * IS NOT ONE IN THE SHARED `credentials` TABLE EITHER. Epic #45 is strict BYO:
 * every AI key belongs to an individual user and lives in
 * `user_ai_credentials`, behind a cascading foreign key. A key in this
 * namespace would be both a secret in a wholesale-returned settings blob and
 * the deployment-wide fallback credential docs/specs/notes.md §9 rejected.
 */
export {
  systemAiSchema,
  systemAiPatchSchema,
  AI_PROVIDER_IDS,
} from '../../ai/ai-settings.schema';

export type {
  SystemAiValue,
  SystemAiPatchValue,
  AiProviderId,
} from '../../ai/ai-settings.schema';
