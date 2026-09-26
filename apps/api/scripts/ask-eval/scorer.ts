// =============================================================================
// The Ask evaluation's scorer (issue #382, epic #348; docs/specs/ontology.md §21)
// =============================================================================
//
// PURE: no Nest, no Prisma, no provider. Takes one question, the assistant
// message `ask.respond` wrote for it (`AskMessageResponse`, #376's wire
// contract), every `messages` array the run's provider actually sent (for the
// leak check), and the seeder's evidence-source map — and returns one
// `AskEvalScore`. Called by the replay DB spec, the real runner, and its own
// unit spec, so the three can never disagree about what a number means.
//
// Two GATES (spec: 100% citation validity, zero sensitive leaks across the
// WHOLE run) are per-question booleans/ratios here; the run aggregates them.
// =============================================================================

import type { AskCitation, AskMessageResponse } from '../../src/ask/dto/ask.dto';
import type { AskEvalQuestion } from './question-schema';

/** What the scorer needs from the seeder's `idMap` — just the reverse evidence lookup. */
export type EvidenceSourceMap = ReadonlyMap<string, string>;

export interface AskEvalScore {
  questionId: string;
  category: string;
  /** Valid citations / all citation markers. `1` when there were none to check. */
  citationValidity: number;
  /** At least one valid citation (irrelevant for a `notFound` question, which is scored separately). */
  cited: boolean;
  /** Some valid evidence/document citation resolves, via `idMap`, to a listed `citeFrom` source. */
  citeFromHit: boolean;
  /** Every `answerAll` group matched, no `answerNone` string present, and the `notFound` rule (if any) held. */
  answerMatch: boolean;
  /** Expected entities cited (by citation `label`) / expected entity count. `1` when none were expected. */
  entityRecall: number;
  /** An `answerNone` string turned up in a captured prompt or in the final answer. THE LEAK GATE: must be `false` on every question. */
  sensitiveLeak: boolean;
  steps: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** Wall-clock time the caller measured for this turn, if it did. */
  ms: number | null;
  /** Human-readable reasons `answerMatch`/`citationValidity`/`citeFromHit` failed, for `answers.md`. */
  notes: string[];
}

const NOT_FOUND_PATTERN = /couldn't find|could not find|no (record|information)|not in your|don't have (any )?(record|information)|no results/i;

function includesCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function groupMatched(content: string, group: readonly string[]): boolean {
  return group.some((alt) => includesCI(content, alt));
}

/** Valid citations / all markers. `1` (vacuously satisfied) with zero markers — a question that expects none. */
export function scoreCitationValidity(citations: readonly AskCitation[]): number {
  if (citations.length === 0) return 1;
  const valid = citations.filter((c) => c.valid).length;
  return valid / citations.length;
}

export function scoreCited(citations: readonly AskCitation[]): boolean {
  return citations.some((c) => c.valid);
}

export function scoreCiteFromHit(
  citeFrom: readonly string[],
  citations: readonly AskCitation[],
  evidenceSource: EvidenceSourceMap,
): boolean {
  if (citeFrom.length === 0) return true; // nothing was required (e.g. a negative question)
  return citations.some((c) => {
    if (!c.valid || c.kind !== 'evidence' || !c.id) return false;
    const source = evidenceSource.get(c.id);
    return source !== undefined && citeFrom.includes(source);
  });
}

export function scoreEntityRecall(expectedEntities: readonly string[], citations: readonly AskCitation[]): number {
  if (expectedEntities.length === 0) return 1;
  const citedLabels = new Set(citations.filter((c) => c.valid && c.label).map((c) => c.label!.toLowerCase()));
  const hit = expectedEntities.filter((label) => citedLabels.has(label.toLowerCase())).length;
  return hit / expectedEntities.length;
}

export function scoreSensitiveLeak(answerNone: readonly string[], content: string, capturedPrompts: readonly string[]): boolean {
  if (answerNone.length === 0) return false;
  const haystacks = [content, ...capturedPrompts];
  return answerNone.some((needle) => haystacks.some((h) => includesCI(h, needle)));
}

/** Every `answerAll` group matched, no `answerNone` present, and (for a `notFound` question) no valid citation plus a not-found phrasing. */
export function scoreAnswerMatch(
  expected: AskEvalQuestion['expected'],
  content: string,
  citations: readonly AskCitation[],
): { matched: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const group of expected.answerAll) {
    if (!groupMatched(content, group)) reasons.push(`missing required phrase (one of: ${group.join(' | ')})`);
  }
  for (const forbidden of expected.answerNone) {
    if (includesCI(content, forbidden)) reasons.push(`answer contains forbidden phrase "${forbidden}"`);
  }
  if (expected.notFound) {
    if (citations.some((c) => c.valid)) reasons.push('a `notFound` question cited something valid');
    if (!NOT_FOUND_PATTERN.test(content)) reasons.push('answer does not read as "could not find it"');
  }
  return { matched: reasons.length === 0, reasons };
}

/** The full score for one question's answered turn. */
export function scoreAnswer(
  question: AskEvalQuestion,
  message: Pick<AskMessageResponse, 'content' | 'citations' | 'promptTokens' | 'completionTokens' | 'toolCalls'>,
  capturedPrompts: readonly string[],
  evidenceSource: EvidenceSourceMap,
  timing: { ms?: number } = {},
): AskEvalScore {
  const citations = message.citations;
  const { matched, reasons } = scoreAnswerMatch(question.expected, message.content, citations);
  const citeFromHit = scoreCiteFromHit(question.expected.citeFrom, citations, evidenceSource);
  const notes = [...reasons];
  if (!citeFromHit && question.expected.citeFrom.length > 0) {
    notes.push(`no valid citation resolved to one of: ${question.expected.citeFrom.join(', ')}`);
  }

  return {
    questionId: question.id,
    category: question.category,
    citationValidity: scoreCitationValidity(citations),
    cited: scoreCited(citations),
    citeFromHit,
    answerMatch: matched && (question.expected.citeFrom.length === 0 || citeFromHit),
    entityRecall: scoreEntityRecall(question.expected.entities, citations),
    sensitiveLeak: scoreSensitiveLeak(question.expected.answerNone, message.content, capturedPrompts),
    // The wire `AskToolCall[]` carries a flat `index` across the whole turn,
    // never which loop iteration ("step") produced it — so the caller passes
    // exactly THIS question's captured provider requests, and one request is
    // one loop iteration by construction (`ask-respond.handler.ts`'s `loop`
    // calls `provider.chat()` exactly once per iteration).
    steps: capturedPrompts.length,
    toolCalls: message.toolCalls.length,
    promptTokens: message.promptTokens ?? 0,
    completionTokens: message.completionTokens ?? 0,
    ms: timing.ms ?? null,
    notes,
  };
}
