// =============================================================================
// This app's own permissions (issue #465, epic #462)
// =============================================================================
//
// The domain permissions the product adds on top of the platform's: NONE of its own any more.
// `transcripts:read|write`, the four note permissions and `graph:read|write` are exported as
// data by the slices of `@marinoscar/kvox-api` (`TRANSCRIPTS_PERMISSIONS`, `NOTES_PERMISSIONS`,
// `NOTE_TEMPLATES_PERMISSIONS`, `GRAPH_PERMISSIONS`) and `kvox-permissions.ts` registers them
// (issues #493, #495 and #496). The empty object stays so the registration call and the
// `PERMISSIONS` derivation keep their shape.
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

export const KVOX_PERMISSIONS = {} as const satisfies Record<string, PermissionDeclaration>;
