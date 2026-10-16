// =============================================================================
// this app's own settings schemas (issue #466, epic #462)
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
// Only this app's own namespaces keep schemas in this repo:
//   transcription  transcription/transcription-settings.schema.ts
//   ai             platform/ai/ai-settings.extension.ts
//   graph          graph/preferences/graph-preferences.schema.ts
//   onboarding     the platform's (`@marinoscar/platform-api/onboarding`, #481)
// =============================================================================

/**
 * AI policy (`ai`): NOT HERE ANY MORE (issue #475, epic #472).
 *
 * The namespace is the platform's `ai` namespace plus this app's extension, declared in
 * `platform/ai/ai-settings.extension.ts`; the view the app reads it through is
 * `ai-port/ai-policy.ts`. The schema this file used to re-export from the retired
 * `ai/` module had no importer left, so the re-export (and the edge into `ai/`) is gone.
 *
 * ⚠ THERE IS NO AI KEY ANYWHERE IN THE `ai` NAMESPACE, AND NONE IN THE SHARED
 * `credentials` TABLE EITHER: every AI key belongs to an individual user (`user_ai_keys`).
 */
export {};
