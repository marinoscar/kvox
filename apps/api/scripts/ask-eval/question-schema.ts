// =============================================================================
// The Ask golden question set: schema (issue #382, epic #348)
// =============================================================================
//
// One JSON file, `apps/api/test/fixtures/kg-golden/ask-questions.json`, holding
// every question the Ask-agent evaluation asks against the seeded gold graph
// (built from #362's synthetic meetings — never real data, per CLAUDE.md's
// "synthetic fixtures only, ever"). A question's `id` is PERMANENT once
// committed, exactly like a fixture's `id` (#362's own rule): retire a
// question by noting it in the README, never by renumbering, so a report is
// comparable across runs.
//
// `fixtures` documents PROVENANCE ONLY — the seeder always loads every fixture
// under #362's `apps/api/test/fixtures/kg-golden/meetings/`, so a question is
// never scoped to a subset at seed time. It exists so a reviewer (or a script
// checking referential integrity, `ask-eval-questions.spec.ts`) can see at a
// glance which meeting(s) a question's expectations are grounded in.
// =============================================================================

import { z } from 'zod';

/** Every category a question may be filed under. Coverage counts live in the README. */
export const ASK_EVAL_CATEGORIES = [
  'lookup',
  'relationship',
  'temporal',
  'as_of',
  'commitments',
  'decisions',
  'multi_hop',
  'negative',
] as const;
export type AskEvalCategory = (typeof ASK_EVAL_CATEGORIES)[number];

export const askEvalExpectedSchema = z.object({
  /**
   * Entity labels that must be cited: either directly (`[^entN]`) or as the
   * subject of a cited evidence row (`[^evN]`/a resolved `[^itmN]`/`[^relN]`)
   * whose citation carries this label. Case-insensitive exact match against
   * the citation's own `label` field — never a substring, since a label is a
   * whole name.
   */
  entities: z.array(z.string()).default([]),
  /**
   * Every inner group must be satisfied by a case-insensitive SUBSTRING match
   * somewhere in the answer text; within a group, any one alternative is
   * enough (synonyms/phrasing variants). `[["Sarah Chen","Sarah"]]` is one
   * group with two acceptable spellings.
   */
  answerAll: z.array(z.array(z.string()).min(1)).default([]),
  /** None of these substrings may appear anywhere in the answer, case-insensitively. */
  answerNone: z.array(z.string()).default([]),
  /**
   * Segment ids (`"m04-s012"`, matching a fixture's own segment id verbatim)
   * or `"mNN#note"` for a meeting's note. At least one VALID citation in the
   * answer must resolve (through the seeder's `idMap`) to one of these.
   * Empty for a `notFound` question, which cites nothing.
   */
  citeFrom: z.array(z.string()).default([]),
  /**
   * A negative question: the agent must say it could not find an answer and
   * must cite nothing valid. `answerNone` still applies — this is where a
   * sensitive fact's own text belongs, so a leak is caught even though the
   * question is "answered" with a refusal.
   */
  notFound: z.boolean().default(false),
});
export type AskEvalExpected = z.infer<typeof askEvalExpectedSchema>;

export const askEvalQuestionSchema = z.object({
  id: z.string().regex(/^q\d{2,3}$/, 'must look like "q01" or "q123"'),
  category: z.enum(ASK_EVAL_CATEGORIES),
  /** Provenance only — see the file header. At least one fixture id (`"m01"`), even for a negative question about an absent entity. */
  fixtures: z.array(z.string().regex(/^m\d{2,3}$/)).min(1),
  /** The label of the entity to scope the conversation to, or `null` for an unscoped conversation. */
  scopeEntity: z.string().nullable().default(null),
  question: z.string().min(5),
  expected: askEvalExpectedSchema,
});
export type AskEvalQuestion = z.infer<typeof askEvalQuestionSchema>;

/** The whole committed file: a bare array of questions. */
export const askEvalQuestionFileSchema = z.array(askEvalQuestionSchema);

export class AskEvalQuestionLoadError extends Error {}

/** Parses and validates the question file's raw JSON. Throws on any schema violation. */
export function parseAskEvalQuestions(raw: unknown): AskEvalQuestion[] {
  const parsed = askEvalQuestionFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new AskEvalQuestionLoadError(`ask-questions.json does not match askEvalQuestionSchema — ${issues}`);
  }
  const seen = new Set<string>();
  for (const q of parsed.data) {
    if (seen.has(q.id)) throw new AskEvalQuestionLoadError(`duplicate question id ${q.id}`);
    seen.add(q.id);
  }
  return parsed.data;
}

/** Loads and validates the committed question file from disk. */
export function loadAskEvalQuestions(path: string): AskEvalQuestion[] {
  // Lazy so callers that already have the parsed JSON (e.g. a spec that reads
  // it once) never need Node's `fs` in their own import graph.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('fs') as typeof import('fs');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new AskEvalQuestionLoadError(`${path}: not valid JSON (${(err as Error).message})`);
  }
  return parseAskEvalQuestions(raw);
}

/** `--only q01,q07` / `--category lookup`: both narrow; neither given keeps all. */
export function selectAskEvalQuestions(
  questions: AskEvalQuestion[],
  only: string[] | null,
  category: string | null,
): AskEvalQuestion[] {
  let out = questions;
  if (only && only.length > 0) {
    const unknown = only.filter((id) => !questions.some((q) => q.id === id));
    if (unknown.length > 0) throw new AskEvalQuestionLoadError(`unknown question id(s): ${unknown.join(', ')}`);
    out = out.filter((q) => only.includes(q.id));
  }
  if (category) out = out.filter((q) => q.category === category);
  return out;
}
