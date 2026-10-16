// =============================================================================
// Settings namespace registrations (issues #459, #460, #466)
// =============================================================================
//
// WHY THIS IS ITS OWN FILE (issue #460). The platform composes the settings
// request/response DTOs and the OpenAPI document from the namespace registries
// when `SettingsModule.forRoot()` runs, and it throws on an empty registry. The
// domain registrations in `kvox.manifest.ts` import domain files that name
// provider classes, and those classes transitively import settings types and
// services. ES imports evaluate in order, so the namespaces must be registered
// by a module `kvox.manifest.ts` imports FIRST.
//
// Since #466 the registration itself is `settings/registry/` (the system and
// user manifests, folding the platform's declarations with this app's from
// `app-registrations/settings.ts`); this file only triggers it.
//
// Order is the stored key order and the OpenAPI order: append, never insert.
//   system: notifications, jobs, nodes, databaseBackup, maintenance,
//           transcription, ai
//   user:   dataTables, navigation, notifications, onboarding, graph
// =============================================================================

import './settings/registry';
