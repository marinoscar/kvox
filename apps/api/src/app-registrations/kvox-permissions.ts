// =============================================================================
// The permission sets of the @marinoscar/kvox-api slices (issue #492, epic #491)
// =============================================================================
//
// Each domain slice of `@marinoscar/kvox-api` exports its permissions as DATA
// (`TRANSCRIPTS_PERMISSIONS`, `NOTES_PERMISSIONS`, ...), and the application
// registers them here with `registerPermissionSet`, keeping today's grants (all
// three org roles for `transcripts:*`, `notes:*`, `note_templates:*`, `graph:*`).
// The package never registers anything itself: a host without these roles
// (a desktop edition) grants every permission instead.
//
// Imported by `registrations.ts`, before the app's own permission manifest: a set
// registered after `registerPlatformPermissions()` has consumed the registry
// fails with `FROZEN`.
//
// TRANSCRIPTION DECLARES NONE OF ITS OWN. Its controllers enforce
// `system_settings:read|write` (the platform's) and `transcripts:read` (this app's
// `KVOX_PERMISSIONS`, declared in `permissions.ts`), passed to the slice in
// `kvox/transcription/transcription.config.ts`. The list starts empty; each
// later slice adds its `*_PERMISSIONS` below, under a slice id of its own.
// =============================================================================

import { registerPermissionSet, type PermissionSetRegistration } from '@marinoscar/platform-api/manifest';

/** The sets to register, in registration order. */
export const KVOX_SLICE_PERMISSION_SETS: readonly PermissionSetRegistration[] = [];

for (const set of KVOX_SLICE_PERMISSION_SETS) {
  registerPermissionSet(set);
}
