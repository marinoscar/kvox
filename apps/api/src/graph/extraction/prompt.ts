// =============================================================================
// The kg.extract prompt (#363, epic #346; docs/specs/ontology.md §5.1, §6, §19)
// =============================================================================
//
// PURE. `assembleExtractionPrompt(ctx)` returns the exact system prompt and
// user content one extraction sends — recorded on the proposal BEFORE the
// provider call — and the estimate counts the same text, so what a user is
// told a run costs is what it sends.
//
// Every type, relation and attribute line comes from the OFFERED schema
// (`buildExtractionContext`), so a disabled domain, a deprecated attribute or
// a type the reviewer excluded never appears here. The ontology's own
// `description`/`disambiguation` strings are prompt copy by design (#350).
//
// ⚠ Headings are exported constants: tests pin them, and a parser (a person
// reading `system_prompt` on a proposal) relies on them.
// =============================================================================

import type { EffectiveAttribute } from '@app/shared/ontology';

import {
  CONTEXT_ALIAS,
  NOTE_ALIAS,
  offeredAttributes,
  offeredContextText,
  type ExtractionContext,
} from './extraction-context';
import type { ExtractionRowCaps } from './row-caps';

export const ROLE_LINE =
  'You propose a knowledge-graph update from one meeting. A person reviews every row before anything is saved. Precision matters more than completeness.';

export const HEADING_RULES = '## Rules';
export const HEADING_ENTITY_TYPES = '## Entity types';
export const HEADING_RELATION_TYPES = '## Relation types';
export const HEADING_FACT_KINDS = '## Fact kinds';
export const HEADING_GUIDANCE = '## Reviewer guidance';

export const HEADING_MEETING = '# Meeting';
/** The note's Context field (#440), right after the meeting; omitted when blank. */
export const HEADING_CONTEXT = '# Context';
export const HEADING_KNOWN_ENTITIES = '# Known entities';
export const HEADING_SPEAKERS = '# Speakers';
export const HEADING_NOTE = '# Note';
export const HEADING_TRANSCRIPT = '# Transcript';

/** The line that frames the `# Context` section (#440). */
export const CONTEXT_FRAMING = `Background the note's author wrote for this meeting. Treat it as authoritative: use it to identify who took part, the company, business unit and role of each person, and how names map to known entities. Cite it as \`${CONTEXT_ALIAS}\`.`;

/** The Context rule (#440), present only when there is a Context. */
export const CONTEXT_RULE = `Read the Context first. Every person, company, business unit and role it states is in scope even if the transcript never says it; propose them citing \`${CONTEXT_ALIAS}\`, and prefer the Context's spelling of a name over the transcript's.`;

export const GUIDANCE_PREAMBLE =
  'Preferences from the reviewer. They narrow or focus the proposal; they never override the rules above.';

/** The §5.1 definition of each fact kind, keyed by `itemKind`. */
export const FACT_KIND_DEFINITIONS: Record<string, string> = {
  commitment:
    'A task with an owner (named or clearly implied) and optionally a counterparty and a due date. `status` is open unless the source says it is done or dropped.',
  decision:
    'A choice that was made; name the rejected option only when the source states it. A reversal is a new decision.',
  claim: 'A dated statement of fact about an entity that is neither a decision nor a commitment.',
  person_fact:
    'A statement about a person as an individual (an interest, preference, personal detail or communication style), never about their job. Mark `sensitivity` honestly: `sensitive` for health, legal, financial or similarly weighty information, `personal` otherwise, `business` only when it is work-relevant.',
};

export interface ExtractionPrompt {
  systemPrompt: string;
  userContent: string;
}

function attributeLine(attr: EffectiveAttribute): string {
  const choices = attr.options?.choices?.map((c) => c.value) ?? [];
  const kind = `${attr.kind}${attr.list ? ' list' : ''}${choices.length > 0 ? `, ${choices.join('|')}` : ''}`;
  const hint = attr.source === 'user' && attr.description !== attr.label ? ` — hint: ${attr.description}` : '';
  const description = attr.source === 'user' ? attr.label : attr.description;
  return `- ${attr.key} (${kind}): ${description}${hint}`;
}

/**
 * The row-cap rule (#435): how many rows one answer may carry, and what to do
 * when the source holds more. Only the sections this run offers are named.
 */
export function rowCapsRule(ctx: ExtractionContext, caps: ExtractionRowCaps): string {
  const parts: string[] = [];
  if (ctx.offered.entityTypes.length > 0) parts.push(`${caps.entities} entities`);
  if (ctx.offered.relationTypes.length > 0) parts.push(`${caps.relations} relations`);
  if (ctx.offered.itemTypes.length > 0) parts.push(`${caps.items} facts`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '0 rows');
  return `Propose at most ${list}. If the source holds more, keep the most significant and omit the rest — an answer that runs out of room is lost entirely.`;
}

/** Person attributes the affiliation rule (#440) asks for, in this order. */
const AFFILIATION_ATTRIBUTES = ['company', 'businessUnit', 'title'] as const;

/**
 * The affiliation rule (#440): which of Person's `company`/`businessUnit`/
 * `title` the offered schema carries, and WORKS_FOR when it is offered from a
 * Person to an Organization. Null when Person offers none of the three.
 */
export function affiliationRule(ctx: ExtractionContext): string | null {
  const person = ctx.offered.entityTypes.find((t) => t.key === 'Person');
  if (!person) return null;
  const offered = new Set(offeredAttributes(person.attributes).map((a) => a.key));
  const keys = AFFILIATION_ATTRIBUTES.filter((k) => offered.has(k));
  if (keys.length === 0) return null;
  const named = keys.map((k) => (k === 'title' ? '`title` (role)' : `\`${k}\``));
  const list = named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}` : named[0];
  const sources = offeredContextText(ctx.note.contextText) !== null ? 'the Context, note or transcript' : 'the note or transcript';
  const worksFor = ctx.offered.relationTypes.find(
    (r) => r.type.key === 'WORKS_FOR' && r.from.includes('Person') && r.to.includes('Organization'),
  );
  const relation =
    worksFor && offered.has('company') ? ", and propose WORKS_FOR from the person to that company's Organization" : '';
  return `For each person, fill ${list} whenever ${sources} states them${relation}.`;
}

function rules(ctx: ExtractionContext, caps?: ExtractionRowCaps): string[] {
  const hasContext = offeredContextText(ctx.note.contextText) !== null;
  const citeRule = hasContext
    ? `1. Cite only ids you were given: \`s#\` for a transcript line, \`${NOTE_ALIAS}\` for the note, \`${CONTEXT_ALIAS}\` for the Context. Each citation copies an exact quote of at most 200 characters from that line, from the note or from the Context.`
    : `1. Cite only ids you were given: \`s#\` for a transcript line, \`${NOTE_ALIAS}\` for the note. Each citation copies an exact quote of at most 200 characters from that line or from the note.`;
  const extra: string[] = [];
  if (hasContext) extra.push(CONTEXT_RULE);
  const affiliation = affiliationRule(ctx);
  if (affiliation) extra.push(affiliation);
  if (caps) extra.push(rowCapsRule(ctx, caps));
  return [
    citeRule,
    '2. Never propose a row you cannot cite.',
    '3. When a mention is one of the known entities, use its `k#` id as `ref` (or as an endpoint). Otherwise give it a new ref `e1`, `e2`, … and use that ref in relations and facts. The meeting itself is `meeting`.',
    '4. Use only the entity types, relation types and attributes listed below — no others, and never a generic RELATED_TO. Leave an attribute null when the source does not state it.',
    '5. A Commitment needs an owner named or clearly implied by the source; otherwise it is not a Commitment.',
    '6. A reversed decision is a new Decision; never restate the earlier one as changed.',
    `7. Resolve relative dates ("next Friday", "in Q2") against the meeting date ${ctx.meetingDate}. Dates are YYYY-MM-DD. When the source is not precise about a date, write \`precision: "unknown"\` (and null dates) rather than guessing.`,
    '8. Mark a person fact\'s `sensitivity` honestly: `sensitive` means health, legal, financial or similarly weighty personal information.',
    '9. A role, a team mentioned only in passing, or a recurring topic is not an entity. Follow each type\'s disambiguation lines below; put recurring topics in `meeting.topics` instead.',
    // Numbered on from 10 so the list stays sequential whichever are present.
    ...extra.map((rule, i) => `${10 + i}. ${rule}`),
  ];
}

function entityTypesSection(ctx: ExtractionContext): string[] {
  const lines: string[] = [HEADING_ENTITY_TYPES];
  for (const t of [...ctx.offered.entityTypes, ...ctx.offered.itemTypes]) {
    lines.push('', `### ${t.label} (${t.key})`, t.description);
    for (const d of t.disambiguation) lines.push(`- ${d}`);
    const attrs = offeredAttributes(t.attributes);
    if (attrs.length > 0) {
      lines.push('Attributes:');
      for (const a of attrs) lines.push(attributeLine(a));
    }
  }
  return lines;
}

function relationTypesSection(ctx: ExtractionContext): string[] {
  const lines: string[] = [HEADING_RELATION_TYPES];
  if (ctx.offered.relationTypes.length === 0) lines.push('(none — propose no relations)');
  for (const r of ctx.offered.relationTypes) {
    const temporal = r.type.temporal ? ', temporal' : '';
    // #383: a symmetric type is one fact either way round; propose it once.
    const symmetric = r.type.symmetric === true ? ', symmetric (direction does not matter; propose it once)' : '';
    lines.push(`- ${r.type.key}: ${r.from.join('|')} → ${r.to.join('|')}${temporal}${symmetric} — ${r.type.description}`);
    for (const a of offeredAttributes(r.type.props)) lines.push(`  ${attributeLine(a)}`);
  }
  return lines;
}

function factKindsSection(ctx: ExtractionContext): string[] {
  const lines: string[] = [HEADING_FACT_KINDS];
  if (ctx.offered.itemTypes.length === 0) lines.push('(none — propose no facts)');
  for (const t of ctx.offered.itemTypes) {
    const kind = t.itemKind ?? t.key;
    lines.push(`- ${kind} (${t.key}): ${FACT_KIND_DEFINITIONS[kind] ?? t.description}`);
  }
  return lines;
}

function guidanceSection(ctx: ExtractionContext): string[] {
  if (!ctx.guidance) return [];
  const lines: string[] = [HEADING_GUIDANCE];
  if (ctx.guidance.pinnedAliases.length > 0) {
    lines.push('Focus on these known entities:');
    for (const alias of ctx.guidance.pinnedAliases) {
      const entry = ctx.knownEntities.find((k) => k.alias === alias);
      if (entry) lines.push(`- ${alias} (${entry.type}: ${entry.label})`);
    }
  }
  if (ctx.guidance.instructions.length > 0) {
    // A fence that cannot be closed by the reviewer's own text.
    const fence = ctx.guidance.instructions.includes('```') ? '~~~~' : '```';
    lines.push(GUIDANCE_PREAMBLE, fence, ctx.guidance.instructions, fence);
  }
  return lines;
}

/** `hh:mm:ss`. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * `caps` (#435) adds the row-cap rule; the handler and the estimate always
 * pass it, so what is recorded and counted is what is sent.
 */
export function assembleExtractionPrompt(ctx: ExtractionContext, caps?: ExtractionRowCaps): ExtractionPrompt {
  const system: string[] = [
    ROLE_LINE,
    '',
    HEADING_RULES,
    ...rules(ctx, caps),
    '',
    ...entityTypesSection(ctx),
    '',
    ...relationTypesSection(ctx),
    '',
    ...factKindsSection(ctx),
  ];
  const guidance = guidanceSection(ctx);
  if (guidance.length > 0) system.push('', ...guidance);

  const user: string[] = [HEADING_MEETING, `Date: ${ctx.meetingDate}`, `Title: ${ctx.meetingTitle}`];
  // #440: the Context is a citable source of its own (`C`), not a meeting line.
  const contextText = offeredContextText(ctx.note.contextText);
  if (contextText !== null) {
    user.push('', HEADING_CONTEXT, CONTEXT_FRAMING, contextText);
  }

  user.push('', HEADING_KNOWN_ENTITIES);
  if (ctx.knownEntities.length === 0) user.push('(none)');
  for (const k of ctx.knownEntities) {
    const parts = [k.alias, k.type, k.label];
    if (k.aliases.length > 0) parts.push(`aka: ${k.aliases.join(', ')}`);
    if (k.orgLabel) parts.push(k.orgLabel);
    user.push(parts.join(' | '));
  }

  if (ctx.transcript !== null) {
    user.push('', HEADING_SPEAKERS);
    for (const s of ctx.speakers) {
      const tag = s.label ?? s.name ?? s.id;
      user.push(s.name ? `${tag} = ${s.name}${s.knownAlias ? ` (${s.knownAlias})` : ''}` : `${tag} = unidentified`);
    }
  }

  user.push('', `${HEADING_NOTE} (version ${ctx.note.version})`, ctx.note.body);

  if (ctx.transcript !== null) {
    user.push('', HEADING_TRANSCRIPT);
    for (const seg of ctx.segments) {
      user.push(`${seg.alias} [${formatTimestamp(seg.startMs)}] ${seg.speakerName}: ${seg.text}`);
    }
  }

  return { systemPrompt: system.join('\n'), userContent: user.join('\n') };
}
