// =============================================================================
// `entity_brief` (#377; docs/specs/ontology.md §9.1, §9.2, §21)
// =============================================================================
//
// `EntityBriefService.getBrief` with `markViewed: false, enqueueStaleDigest:
// false` — the agent is READ-ONLY: it neither moves the user's "last viewed"
// marker nor enqueues a digest refresh, and #372 never composes prose inside a
// request, so this tool never causes an AI call either. It returns the five
// deterministic, cited sections plus the latest STORED digest; when that
// digest is stale the summary says so, so the model leans on the sections.
//
// The brief's sections never contain a `sensitive` PersonFact; `personal` ones
// are dropped here unless the §14 opt-in is on (the brief response carries no
// sensitivity, so it is looked up, owner-scoped, for the PersonFact entries).
// =============================================================================

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { BriefEntry, PeopleChange } from '../../graph/brief/dto/entity-brief.dto';
import { EntityBriefService } from '../../graph/brief/entity-brief.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  clip,
  isoDate,
  jsonNullableString,
  jsonString,
  objectParameters,
  optionalOf,
  precisionField,
  resolveHandleOrThrow,
  STATEMENT_MAX_CHARS,
  zDate,
  zHandle,
  type AskTool,
  type AskToolContext,
  type AskToolResult,
} from './ask-tool';
import { visiblePersonFactIds } from './sensitivity';
import { INLINE_EVIDENCE_PER_ENTRY } from './tool-queries';

const input = z.object({
  entity: zHandle,
  since: optionalOf(zDate),
  asOf: optionalOf(zDate),
});
export type EntityBriefToolInput = z.output<typeof input>;

@Injectable()
export class EntityBriefTool implements AskTool<EntityBriefToolInput> {
  readonly name = 'entity_brief';
  readonly description =
    'Get a cited summary of what is new about an entity: what changed, decisions, open commitments, risks and claims, people changes.';
  readonly parameters = objectParameters({
    entity: jsonString('An entity reference (entN).'),
    since: jsonNullableString('Start of the "what changed" window (YYYY-MM-DD). Default: the last 30 days or the last summary.'),
    asOf: jsonNullableString('Evaluate the brief as of this date (YYYY-MM-DD). Default: today. With it, no stored summary is returned.'),
  });
  readonly input = input;

  constructor(
    private readonly brief: EntityBriefService,
    private readonly prisma: PrismaService,
  ) {}

  async run(ctx: AskToolContext, args: EntityBriefToolInput): Promise<AskToolResult> {
    const target = resolveHandleOrThrow(ctx, args.entity, ['ent']);
    const res = await this.brief.getBrief(ctx.user, target.id, {
      since: args.since,
      asOf: args.asOf,
      markViewed: false,
      enqueueStaleDigest: false,
    });
    const { sections } = res;

    const allEntries = [
      ...sections.whatChanged,
      ...sections.decisions,
      ...sections.openCommitments.theirs,
      ...sections.openCommitments.yours,
      ...sections.risksClaims,
    ];
    const factIds = allEntries.filter((e) => e.kind === 'person_fact').map((e) => e.itemId);
    const visibleFacts = await visiblePersonFactIds(this.prisma, ctx.user.id, factIds, ctx.personalFactsAllowed);
    const keep = (e: BriefEntry) => e.kind !== 'person_fact' || visibleFacts.has(e.itemId);

    const evRefs = (ids: readonly string[]) =>
      ids.slice(0, INLINE_EVIDENCE_PER_ENTRY).map((id) => ctx.handles.register({ kind: 'ev', id }));

    const entry = (e: BriefEntry) => {
      const label = e.title ?? clip(e.statement, 80);
      return {
        ref: ctx.handles.register({ kind: 'itm', id: e.itemId, label }),
        kind: e.kind,
        text: clip(e.title ? `${e.title}: ${e.statement}` : e.statement, STATEMENT_MAX_CHARS),
        at: isoDate(e.occurredAt),
        ...precisionField(e.precision),
        ...(e.dueAt ? { due: isoDate(e.dueAt) } : {}),
        ...(e.superseded ? { superseded: true } : {}),
        evidence: evRefs(e.evidenceIds),
      };
    };
    const section = (list: readonly BriefEntry[]) => list.filter(keep).map(entry);

    const peopleChange = (p: PeopleChange) => {
      const person = ctx.handles.register({ kind: 'ent', id: p.person.id, label: p.person.label });
      const other = ctx.handles.register({ kind: 'ent', id: p.other.id, label: p.other.label });
      const title = p.title ? ` (${p.title})` : '';
      return {
        ref: ctx.handles.register({ kind: 'rel', id: p.relationId, label: p.type }),
        text: `${p.person.label} ${p.change} ${p.type}${title} with ${p.other.label}`,
        person: { ref: person, label: p.person.label },
        other: { ref: other, label: p.other.label },
        at: isoDate(p.at),
        ...precisionField(p.precision),
        evidence: evRefs(p.evidenceIds),
      };
    };

    const data = {
      window: { since: isoDate(res.window.since), asOf: isoDate(res.window.asOf) },
      digest: res.digest
        ? res.digest.statements.map((s) => ({
            text: clip(s.text, STATEMENT_MAX_CHARS),
            evidence: s.evidenceIds.map((id) => ctx.handles.register({ kind: 'ev', id })),
          }))
        : null,
      digestStale: res.digestStale,
      digestGeneratedAt: res.digest ? isoDate(res.digest.generatedAt) : null,
      whatChanged: section(sections.whatChanged),
      decisions: section(sections.decisions),
      openCommitments: {
        theirs: section(sections.openCommitments.theirs),
        yours: section(sections.openCommitments.yours),
      },
      risksClaims: section(sections.risksClaims),
      peopleChanges: sections.peopleChanges.map(peopleChange),
    };

    const resultCount =
      data.whatChanged.length +
      data.decisions.length +
      data.openCommitments.theirs.length +
      data.openCommitments.yours.length +
      data.risksClaims.length +
      data.peopleChanges.length;
    const label = res.entity.label;
    const parts = [
      `${data.whatChanged.length} changes`,
      `${data.decisions.length} decisions`,
      `${data.openCommitments.theirs.length + data.openCommitments.yours.length} open commitments`,
    ];
    return {
      data,
      resultCount,
      summary: `Brief for ${label} · ${parts.join(', ')}${res.digestStale ? ' · summary may be out of date' : ''}`,
      truncated: false,
    };
  }
}
