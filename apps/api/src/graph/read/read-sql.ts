// =============================================================================
// SQL fragments every graph read query shares (#370)
// =============================================================================
//
// "Readable" spelled once in SQL, from the lists in `readable.ts`. Status lists
// are this codebase's own constants, so they are inlined as literals (after a
// pattern check) rather than bound — which lets the planner use the
// `(owner_id, type, review_status)` indexes.
// =============================================================================

import { Prisma } from '@prisma/client';

import {
  AS_OF_RELATION_STATUSES,
  READABLE_ENTITY_STATUSES,
  READABLE_ITEM_STATUSES,
  READABLE_MENTION_STATUSES,
  READABLE_RELATION_STATUSES,
} from './readable';

const IDENT = /^[a-z][a-z0-9_]*$/;
/** Enum members and ontology keys: `accepted`, `person_fact`, `ATTENDED`. */
const LITERAL = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A table alias or column name from this codebase's own literals. */
export function ident(name: string): Prisma.Sql {
  if (!IDENT.test(name)) throw new Error(`invalid SQL identifier '${name}'`);
  return Prisma.raw(name);
}

/** `('a','b')` from constant, pattern-checked values. */
export function literalList(values: readonly string[]): Prisma.Sql {
  if (values.length === 0) throw new Error('literalList needs at least one value');
  for (const v of values) if (!LITERAL.test(v)) throw new Error(`invalid SQL literal '${v}'`);
  return Prisma.raw(`(${values.map((v) => `'${v}'`).join(',')})`);
}

/** A uuid[] parameter. */
export function uuidArray(ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`${[...ids]}::uuid[]`;
}

/** A text[] parameter. */
export function textArray(values: readonly string[]): Prisma.Sql {
  return Prisma.sql`${[...values]}::text[]`;
}

/** Readable, not a merge tombstone. */
export function readableEntitySql(a: string): Prisma.Sql {
  const t = ident(a);
  return Prisma.sql`(${t}.review_status IN ${literalList(READABLE_ENTITY_STATUSES)} AND ${t}.merged_into_id IS NULL)`;
}

export function readableRelationSql(a: string): Prisma.Sql {
  return Prisma.sql`${ident(a)}.review_status IN ${literalList(READABLE_RELATION_STATUSES)}`;
}

/** For as-of evaluation: readable plus `superseded` (see `readable.ts`). */
export function asOfRelationSql(a: string): Prisma.Sql {
  return Prisma.sql`${ident(a)}.review_status IN ${literalList(AS_OF_RELATION_STATUSES)}`;
}

export function readableItemSql(a: string, statuses: readonly string[] = READABLE_ITEM_STATUSES): Prisma.Sql {
  return Prisma.sql`${ident(a)}.review_status IN ${literalList(statuses)}`;
}

/** Never a `sensitive` person fact (§5.6). */
export function notSensitiveSql(a: string): Prisma.Sql {
  const t = ident(a);
  return Prisma.sql`NOT (${t}.kind = 'person_fact' AND ${t}.sensitivity IS NOT DISTINCT FROM 'sensitive')`;
}

export function readableMentionSql(a: string): Prisma.Sql {
  return Prisma.sql`${ident(a)}.status IN ${literalList(READABLE_MENTION_STATUSES)}`;
}

/** Postgres `timestamptz` → ISO string with microseconds, so a keyset cursor round-trips exactly. */
export function isoMicrosSql(expr: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
