import type { KvoxPermissionDeclaration } from '../transcripts/index.js';

// =============================================================================
// The permissions of the notes slice, as data (issue #495, epic #491)
// =============================================================================
//
// The slice never registers a permission itself: a host without roles (a desktop
// edition) grants every permission instead. The web edition registers
// {@link NOTES_PERMISSIONS} and {@link NOTE_TEMPLATES_PERMISSIONS} in
// `apps/api/src/app-registrations/kvox-permissions.ts` with
// `registerPermissionSet`, keeping today's grants: all three org roles.
//
// THERE IS DELIBERATELY NO `notes:read_any`. A note is derived from somebody's private
// conversation; no permission string for reading another user's exists, for any role,
// ever. A caller with no access gets a 404, never a 403 (`docs/specs/notes.md` §6).
// =============================================================================


/** The role ids of an organization membership, as the web edition seeds them. */
const ALL_ORG_ROLES = ['org_admin', 'contributor', 'viewer'] as const;

/** The permission `notes:read`. @stability experimental */
export const NOTES_READ_PERMISSION = 'notes:read';

/** The permission `notes:write`. @stability experimental */
export const NOTES_WRITE_PERMISSION = 'notes:write';

/** The permission `note_templates:read`. @stability experimental */
export const NOTE_TEMPLATES_READ_PERMISSION = 'note_templates:read';

/** The permission `note_templates:write`. @stability experimental */
export const NOTE_TEMPLATES_WRITE_PERMISSION = 'note_templates:write';

/**
 * The note permissions (`notes:read`, `notes:write`). Granted to all three org roles.
 *
 * @extensionPoint
 * @stability experimental
 */
export const NOTES_PERMISSIONS: readonly KvoxPermissionDeclaration[] = [
  {
    id: NOTES_READ_PERMISSION,
    description: 'Read own notes (list, get, versions, the generation stream)',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
  {
    id: NOTES_WRITE_PERMISSION,
    description: 'Create, regenerate, edit and delete own notes; preview a note template',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
];

/**
 * The note template permissions (`note_templates:read`, `note_templates:write`).
 * Granted to all three org roles.
 *
 * @extensionPoint
 * @stability experimental
 */
export const NOTE_TEMPLATES_PERMISSIONS: readonly KvoxPermissionDeclaration[] = [
  {
    id: NOTE_TEMPLATES_READ_PERMISSION,
    description: 'Read the built-in and own note templates',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
  {
    id: NOTE_TEMPLATES_WRITE_PERMISSION,
    description: 'Create, edit and delete own custom note templates',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
];
