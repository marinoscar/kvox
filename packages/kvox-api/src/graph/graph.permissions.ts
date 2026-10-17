import type { KvoxPermissionDeclaration } from '../transcripts/index.js';

// =============================================================================
// The permissions of the graph slice, as data (issue #496, epic #491)
// =============================================================================
//
// The slice never registers a permission itself: a host without roles (a desktop
// edition) grants every permission instead. The web edition registers
// {@link GRAPH_PERMISSIONS} in `apps/api/src/app-registrations/kvox-permissions.ts`
// with `registerPermissionSet`, keeping today's grants: all three org roles.
//
// THERE IS DELIBERATELY NO `graph:read_any`. A graph is derived from somebody's private
// conversations; no permission string for reading another user's exists, for any role,
// ever. A caller with no access gets a 404, never a 403 (`docs/specs/ontology.md` §12).
// =============================================================================

/** The role ids of an organization membership, as the web edition seeds them. */
const ALL_ORG_ROLES = ['org_admin', 'contributor', 'viewer'] as const;

/** The permission `graph:read`. @stability experimental */
export const GRAPH_READ_PERMISSION = 'graph:read';

/** The permission `graph:write`. @stability experimental */
export const GRAPH_WRITE_PERMISSION = 'graph:write';

/**
 * The graph permissions (`graph:read`, `graph:write`). Granted to all three org roles.
 *
 * @extensionPoint
 * @stability experimental
 */
export const GRAPH_PERMISSIONS: readonly KvoxPermissionDeclaration[] = [
  {
    id: GRAPH_READ_PERMISSION,
    description:
      'Read own connected-knowledge graph: entities, relations, facts, proposals and the effective ontology',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
  {
    id: GRAPH_WRITE_PERMISSION,
    description:
      'Commit proposals and edit, merge and forget entities in own graph; manage attribute definitions',
    scope: 'org',
    defaultGrants: ALL_ORG_ROLES,
  },
];
