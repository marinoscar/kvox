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
// `system_settings:read|write` (the platform's) and `transcripts:read` (the
// transcripts slice's, below), passed to the slice in
// `kvox/transcription/transcription.config.ts`. Each slice that declares permissions
// adds its `*_PERMISSIONS` to the list, under a slice id of its own:
//
//   kvox-transcripts   TRANSCRIPTS_PERMISSIONS   transcripts:read, transcripts:write
//                      (issue #493; before it, `permissions.ts` declared them. The order
//                      of the catalog is unchanged: a registered set comes after the
//                      platform's permissions and before the app's.)
//   kvox-notes         NOTES_PERMISSIONS, NOTE_TEMPLATES_PERMISSIONS
//                      notes:read, notes:write, note_templates:read, note_templates:write
//                      (issue #495; same posture: all three org roles. They follow the
//                      transcripts and precede the graph's, which are still the app's own.)
// =============================================================================

import { NOTE_TEMPLATES_PERMISSIONS, NOTES_PERMISSIONS } from '@marinoscar/kvox-api/notes';
import { TRANSCRIPTS_PERMISSIONS } from '@marinoscar/kvox-api/transcripts';
import { registerPermissionSet, type PermissionSetRegistration } from '@marinoscar/platform-api/manifest';

/** The sets to register, in registration order. */
export const KVOX_SLICE_PERMISSION_SETS: readonly PermissionSetRegistration[] = [
  {
    slice: 'kvox-transcripts',
    permissions: TRANSCRIPTS_PERMISSIONS.map((permission) => ({
      id: permission.id,
      description: permission.description,
      scope: permission.scope,
      defaultGrants: [...permission.defaultGrants],
    })),
  },
  {
    slice: 'kvox-notes',
    permissions: [...NOTES_PERMISSIONS, ...NOTE_TEMPLATES_PERMISSIONS].map((permission) => ({
      id: permission.id,
      description: permission.description,
      scope: permission.scope,
      defaultGrants: [...permission.defaultGrants],
    })),
  },
];

for (const set of KVOX_SLICE_PERMISSION_SETS) {
  registerPermissionSet(set);
}
