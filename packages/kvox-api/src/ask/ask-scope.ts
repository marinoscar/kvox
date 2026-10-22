// =============================================================================
// The per-turn `scope` of an Ask question (GIC-17, #678; docs/specs/ontology.md §9.4, §22.4)
// =============================================================================
//
// "Ask about this selection" in the explorer sends the entity ids the user selected and, for an
// edge or a path, the ids of its evidence. They are STARTING HANDLES for the agent:
//
//   - every id must be readable by the asker (`WHERE owner_id = $user`, a readable review status,
//     not merged away, not a personal-by-declaration type, and never a `sensitive` PersonFact);
//     one that is not makes the WHOLE request a 404 with one sentence, whether the id is missing,
//     another user's or sensitive — the no-access answer never says which;
//   - an evidence id resolves to the entity, item or relation it supports. The turn registers THAT
//     subject as a handle (`entN`, `itmN`, `relN`) and the agent reads the quote itself through its
//     `evidence` tool. The quote is never put in the prompt, so the answer can only cite what the
//     agent actually retrieved: the graph is never a retrieval source on its own.
//
// `resolveAskScope` is used twice: by the POST (strict — a miss is a 404) and by the job (lenient —
// the ids are re-checked against today's data and a vanished one is dropped).
// =============================================================================

import { NotFoundException } from '@nestjs/common';

import { READABLE_ENTITY_STATUSES, TIMELINE_ITEM_STATUSES, AS_OF_RELATION_STATUSES } from '../graph/index.js';
import type { KvoxAskDb } from './data/ask-db.js';
import { hiddenTypes, itemVisible } from './tools/sensitivity.js';

/**
 * The 404 sentence for a scope id that is missing, another user's, or not readable.
 *
 * @stability experimental
 */
export const ASK_SCOPE_NOT_FOUND = 'Selection not found';

/** The scope as it travels: ids only. */
export interface AskScopeInput {
  entityIds?: readonly string[];
  evidenceIds?: readonly string[];
}

/** One handle-worthy subject the scope resolved to. */
export interface AskScopeSubject {
  kind: 'ent' | 'itm' | 'rel';
  id: string;
  /** Entity label, or the item kind / relation type for the others. */
  label: string;
  /** Entity type key, item kind, or relation type key. */
  type: string;
}

/** What {@link resolveAskScope} found. */
export interface ResolvedAskScope {
  /** The readable subjects, entities first, in the order asked; no duplicates. */
  subjects: AskScopeSubject[];
  /** `true` when at least one id asked for was not readable. */
  missing: boolean;
}

/** The ids of a scope with duplicates removed; an absent list is empty. */
export function uniqueScopeIds(ids: readonly string[] | undefined): string[] {
  return [...new Set(ids ?? [])];
}

/**
 * Resolves a scope against the asker's own, readable rows.
 *
 * @param prisma - The slice's database view.
 * @param ownerId - The asker.
 * @param scope - The ids to resolve.
 * @param personalFactsAllowed - The §14 opt-in; `false` today.
 * @returns The readable subjects and whether any id was unreadable.
 */
export async function resolveAskScope(
  prisma: KvoxAskDb,
  ownerId: string,
  scope: AskScopeInput,
  personalFactsAllowed = false,
): Promise<ResolvedAskScope> {
  const subjects = new Map<string, AskScopeSubject>();
  let missing = false;

  const entityIds = uniqueScopeIds(scope.entityIds);
  const evidenceIds = uniqueScopeIds(scope.evidenceIds);

  const readableEntities = async (ids: string[]) =>
    ids.length === 0
      ? []
      : ((await prisma.kgEntity.findMany({
          where: {
            id: { in: ids },
            ownerId,
            mergedIntoId: null,
            reviewStatus: { in: [...READABLE_ENTITY_STATUSES] },
            type: { notIn: hiddenTypes(personalFactsAllowed) },
          },
          select: { id: true, label: true, type: true },
        })) as Array<{ id: string; label: string; type: string }>);

  const addEntities = (rows: Array<{ id: string; label: string; type: string }>) => {
    for (const row of rows) subjects.set(`ent:${row.id}`, { kind: 'ent', id: row.id, label: row.label, type: row.type });
  };

  const entities = await readableEntities(entityIds);
  const byId = new Map(entities.map((row) => [row.id, row]));
  for (const id of entityIds) {
    const row = byId.get(id);
    if (row) addEntities([row]);
    else missing = true;
  }

  if (evidenceIds.length > 0) {
    const links = (await prisma.kgEvidence.findMany({
      where: { id: { in: evidenceIds }, ownerId },
      select: { id: true, subjectKind: true, subjectId: true },
    })) as Array<{ id: string; subjectKind: string; subjectId: string }>;
    const found = new Set(links.map((link) => link.id));
    if (evidenceIds.some((id) => !found.has(id))) missing = true;

    const entitySubjects = [...new Set(links.filter((l) => l.subjectKind === 'entity').map((l) => l.subjectId))];
    const itemSubjects = [...new Set(links.filter((l) => l.subjectKind === 'item').map((l) => l.subjectId))];
    const relationSubjects = [...new Set(links.filter((l) => l.subjectKind === 'relation').map((l) => l.subjectId))];

    const subjectEntities = await readableEntities(entitySubjects);
    addEntities(subjectEntities);
    const readableEntityIds = new Set(subjectEntities.map((row) => row.id));

    const items =
      itemSubjects.length === 0
        ? []
        : ((await prisma.kgItem.findMany({
            where: { id: { in: itemSubjects }, ownerId, reviewStatus: { in: [...TIMELINE_ITEM_STATUSES] } },
            select: { id: true, kind: true, sensitivity: true },
          })) as Array<{ id: string; kind: string; sensitivity: string | null }>);
    const readableItems = new Set<string>();
    for (const item of items) {
      if (!itemVisible(item, personalFactsAllowed)) continue;
      readableItems.add(item.id);
      subjects.set(`itm:${item.id}`, { kind: 'itm', id: item.id, label: item.kind, type: item.kind });
    }

    const relations =
      relationSubjects.length === 0
        ? []
        : ((await prisma.kgRelation.findMany({
            where: {
              id: { in: relationSubjects },
              ownerId,
              reviewStatus: { in: [...AS_OF_RELATION_STATUSES] },
              type: { notIn: hiddenTypes(personalFactsAllowed) },
            },
            select: { id: true, type: true },
          })) as Array<{ id: string; type: string }>);
    const readableRelations = new Set<string>();
    for (const relation of relations) {
      readableRelations.add(relation.id);
      subjects.set(`rel:${relation.id}`, { kind: 'rel', id: relation.id, label: relation.type, type: relation.type });
    }

    // An evidence link whose subject is not readable (a sensitive PersonFact, a merged entity, a
    // personal type) is itself not readable.
    for (const link of links) {
      const ok =
        (link.subjectKind === 'entity' && readableEntityIds.has(link.subjectId)) ||
        (link.subjectKind === 'item' && readableItems.has(link.subjectId)) ||
        (link.subjectKind === 'relation' && readableRelations.has(link.subjectId));
      if (!ok) missing = true;
    }
  }

  return { subjects: [...subjects.values()], missing };
}

/**
 * Validates a scope for a POST: the same 404 for any unreadable id.
 *
 * @param prisma - The slice's database view.
 * @param ownerId - The asker.
 * @param scope - The ids to validate.
 * @throws NotFoundException when any id is not readable by the asker.
 */
export async function assertAskScopeReadable(prisma: KvoxAskDb, ownerId: string, scope: AskScopeInput): Promise<void> {
  const resolved = await resolveAskScope(prisma, ownerId, scope);
  if (resolved.missing) throw new NotFoundException(ASK_SCOPE_NOT_FOUND);
}
