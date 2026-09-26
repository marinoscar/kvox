// =============================================================================
// `kg.purge` payload (#357, epic #344; docs/specs/ontology.md §11, §15)
// =============================================================================
//
// Two shapes, one per scope, and nothing else:
//
//   { userId, scope: 'all' }                    — the Danger Zone's `graph`
//                                                  category (`content`/`everything`)
//   { userId, scope: 'person', entityId }       — "Forget this person"
//
// ⚠ THESE STRINGS ARE PERMANENT once a queued row carries one — the same rule
// `USER_DATA_SCOPES` states. A handler that ran minutes later against a renamed
// scope would silently widen or narrow what it destroys.
//
// `readKgPurgePayload` answers `null` for anything else, and the handler then
// RETURNS (logging `warn`) rather than throwing, exactly as `user.data.purge`
// does: an unreadable payload is not a condition a retry could fix, and a
// destructive job must never guess at what it was asked to delete.
// =============================================================================

export const KG_PURGE_SCOPES = ['all', 'person'] as const;

export type KgPurgeScope = (typeof KG_PURGE_SCOPES)[number];

export type KgPurgePayload =
  | { userId: string; scope: 'all' }
  | { userId: string; scope: 'person'; entityId: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Parse a `jobs.payload`, or `null` for anything that is not exactly one of the two shapes. */
export function readKgPurgePayload(value: unknown): KgPurgePayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (!isUuid(record.userId)) return null;

  if (record.scope === 'all') {
    return { userId: record.userId, scope: 'all' };
  }

  if (record.scope === 'person') {
    if (!isUuid(record.entityId)) return null;
    return { userId: record.userId, scope: 'person', entityId: record.entityId };
  }

  return null;
}
