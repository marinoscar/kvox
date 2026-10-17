// =============================================================================
// This app's own permissions (issue #465, epic #462)
// =============================================================================
//
// The domain permissions the product adds on top of the platform's: six declared
// here, and `transcripts:read|write`, which the transcripts slice of
// `@marinoscar/kvox-api` exports as data (`TRANSCRIPTS_PERMISSIONS`) and
// `kvox-permissions.ts` registers (issue #493).
// Every one is ORG-SCOPED: a user holds it through the role on their
// membership of the current organization (`org_admin`, `contributor`,
// `viewer`), never through `user_roles`. The system `admin` role no longer
// carries them; an admin reaches them through the `org_admin` membership the
// platform migration `0024_split_system_org_roles` gave them.
//
// GRANTED TO ALL THREE ORG ROLES, the same posture as before the move:
// transcribing a recording, generating a note and curating one's own graph are
// the core product actions, and a new user's default role is `viewer`.
//
// THERE IS DELIBERATELY NO `*:read_any` FOR TRANSCRIPTS, NOTES OR THE GRAPH.
// They are derived from somebody's private conversations; no permission string
// for reading another user's content exists, for any role, ever. A caller with
// no access gets a 404, never a 403. See docs/specs/transcription.md §6,
// docs/specs/notes.md §6.3 and docs/specs/ontology.md §12.
//
// This file has NO side effects (it only declares), so `common/constants/
// roles.constants.ts` can derive the `PERMISSIONS` constant from it without
// registering anything. The registration is `registrations.ts`.
// =============================================================================

import type { PermissionDeclaration } from '@marinoscar/platform-api/core';

const ALL_ORG_ROLES = ['org_admin', 'contributor', 'viewer'] as const;

export const KVOX_PERMISSIONS = {
  NOTES_READ: {
    id: 'notes:read',
    description: 'Read own notes (list, get, versions, the generation stream)',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
  NOTES_WRITE: {
    id: 'notes:write',
    description:
      'Create, regenerate, edit and delete own notes; preview a note template',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
  NOTE_TEMPLATES_READ: {
    id: 'note_templates:read',
    description: 'Read the built-in and own note templates',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
  NOTE_TEMPLATES_WRITE: {
    id: 'note_templates:write',
    description: 'Create, edit and delete own custom note templates',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
  GRAPH_READ: {
    id: 'graph:read',
    description:
      'Read own connected-knowledge graph: entities, relations, facts, proposals and the effective ontology',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
  GRAPH_WRITE: {
    id: 'graph:write',
    description:
      'Commit proposals and edit, merge and forget entities in own graph; manage attribute definitions',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
} as const satisfies Record<string, PermissionDeclaration>;
