// =============================================================================
// The permissions of the transcripts slice, as data (issue #493, epic #491)
// =============================================================================
//
// The slice never registers a permission itself: a host without roles (a desktop
// edition) grants every permission instead. The web edition registers
// {@link TRANSCRIPTS_PERMISSIONS} in `apps/api/src/app-registrations/
// kvox-permissions.ts` with `registerPermissionSet`, keeping today's grants: all
// three org roles.
//
// THERE IS DELIBERATELY NO `transcripts:read_any`. A transcript is somebody's
// private conversation; no permission string for reading another user's exists,
// for any role, ever. A caller with no access gets a 404, never a 403
// (`docs/specs/transcription.md` §6).
// =============================================================================

/**
 * One permission the slice enforces, declared as data.
 *
 * @stability experimental
 */
export interface KvoxPermissionDeclaration {
  /** The exact string a controller enforces (`transcripts:read`). Persisted; never renamed. */
  id: string;
  /** What holding it allows, for the permission catalog. */
  description: string;
  /** Held through an organization membership (`org`) or system-wide (`system`). */
  scope: 'org' | 'system';
  /** The role ids that hold it unless an operator changes the grant. */
  defaultGrants: readonly string[];
}

/** The role ids of an organization membership, as the web edition seeds them. */
const ALL_ORG_ROLES = ['org_admin', 'contributor', 'viewer'] as const;

/**
 * The permission `transcripts:read`.
 *
 * @stability experimental
 */
export const TRANSCRIPTS_READ_PERMISSION = 'transcripts:read';

/**
 * The permission `transcripts:write`.
 *
 * @stability experimental
 */
export const TRANSCRIPTS_WRITE_PERMISSION = 'transcripts:write';

/**
 * The permissions of the transcripts slice. Granted to all three org roles.
 *
 * @extensionPoint
 * @stability experimental
 */
export const TRANSCRIPTS_PERMISSIONS: readonly KvoxPermissionDeclaration[] = [
  {
    id: TRANSCRIPTS_READ_PERMISSION,
    description: 'Read own and shared transcripts (list, get, segments, versions, exporters)',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
  {
    id: TRANSCRIPTS_WRITE_PERMISSION,
    description:
      'Create, correct, share and delete own transcripts; edit a transcript shared with the editor role',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
];
