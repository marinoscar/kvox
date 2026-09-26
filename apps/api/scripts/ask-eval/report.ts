// =============================================================================
// The Ask evaluation's report: per-category rollup + the two gates (#382)
// =============================================================================

import { z } from 'zod';

import type { AskEvalScore } from './scorer';

const ratioSchema = z.number().min(0).max(1);

export const askEvalReportSchema = z.object({
  runAt: z.string(),
  model: z.string().nullable(),
  questions: z.number().int(),
  categories: z.array(
    z.object({
      category: z.string(),
      count: z.number().int(),
      answerMatch: ratioSchema,
      cited: ratioSchema,
      entityRecall: ratioSchema,
      meanSteps: z.number(),
      meanToolCalls: z.number(),
      meanPromptTokens: z.number(),
      meanCompletionTokens: z.number(),
      meanMs: z.number().nullable(),
    }),
  ),
  overall: z.object({
    answerMatch: ratioSchema,
    citationValidity: ratioSchema,
    sensitiveLeaks: z.number().int(),
  }),
  /** `citationValidity === 1` and `sensitiveLeaks === 0` — the two hard gates. */
  gatesPassed: z.boolean(),
  /** `overall.answerMatch >= minMatch`. */
  answerMatchPassed: z.boolean(),
  minMatch: ratioSchema,
  perQuestion: z.array(
    z.object({
      id: z.string(),
      category: z.string(),
      citationValidity: ratioSchema,
      cited: z.boolean(),
      citeFromHit: z.boolean(),
      answerMatch: z.boolean(),
      entityRecall: ratioSchema,
      sensitiveLeak: z.boolean(),
      steps: z.number().int(),
      toolCalls: z.number().int(),
      promptTokens: z.number().int(),
      completionTokens: z.number().int(),
      ms: z.number().nullable(),
      notes: z.array(z.string()),
    }),
  ),
});
export type AskEvalReport = z.infer<typeof askEvalReportSchema>;

const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

export function buildAskEvalReport(
  scores: AskEvalScore[],
  meta: { model: string | null; minMatch: number; runAt?: Date },
): AskEvalReport {
  const byCategory = new Map<string, AskEvalScore[]>();
  for (const s of scores) byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s]);

  const categories = [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, rows]) => ({
      category,
      count: rows.length,
      answerMatch: mean(rows.map((r) => (r.answerMatch ? 1 : 0))),
      cited: mean(rows.map((r) => (r.cited ? 1 : 0))),
      entityRecall: mean(rows.map((r) => r.entityRecall)),
      meanSteps: mean(rows.map((r) => r.steps)),
      meanToolCalls: mean(rows.map((r) => r.toolCalls)),
      meanPromptTokens: mean(rows.map((r) => r.promptTokens)),
      meanCompletionTokens: mean(rows.map((r) => r.completionTokens)),
      meanMs: rows.every((r) => r.ms === null) ? null : mean(rows.map((r) => r.ms ?? 0)),
    }));

  const citationValidity = mean(scores.map((s) => s.citationValidity));
  const sensitiveLeaks = scores.filter((s) => s.sensitiveLeak).length;
  const answerMatch = mean(scores.map((s) => (s.answerMatch ? 1 : 0)));
  const gatesPassed = citationValidity === 1 && sensitiveLeaks === 0;

  return {
    runAt: (meta.runAt ?? new Date()).toISOString(),
    model: meta.model,
    questions: scores.length,
    categories,
    overall: { answerMatch, citationValidity, sensitiveLeaks },
    gatesPassed,
    answerMatchPassed: answerMatch >= meta.minMatch,
    minMatch: meta.minMatch,
    perQuestion: scores.map((s) => ({
      id: s.questionId,
      category: s.category,
      citationValidity: s.citationValidity,
      cited: s.cited,
      citeFromHit: s.citeFromHit,
      answerMatch: s.answerMatch,
      entityRecall: s.entityRecall,
      sensitiveLeak: s.sensitiveLeak,
      steps: s.steps,
      toolCalls: s.toolCalls,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      ms: s.ms,
      notes: s.notes,
    })),
  };
}

const fmt = (v: number) => v.toFixed(3);
const pad = (s: string | number, n: number) => String(s).padEnd(n);

export function formatAskEvalReport(r: AskEvalReport): string {
  const lines: string[] = [];
  lines.push(`ask:eval  questions=${r.questions}  model=${r.model ?? '-'}  ${r.runAt}`);
  lines.push(
    `${pad('CATEGORY', 14)}${pad('N', 4)}${pad('ANSWER', 8)}${pad('CITED', 8)}${pad('ENT.RECALL', 12)}${pad('STEPS', 8)}${pad('TOKENS(p/c)', 14)}MS`,
  );
  for (const c of r.categories) {
    lines.push(
      `${pad(c.category, 14)}${pad(c.count, 4)}${pad(fmt(c.answerMatch), 8)}${pad(fmt(c.cited), 8)}${pad(fmt(c.entityRecall), 12)}${pad(
        c.meanSteps.toFixed(1),
        8,
      )}${pad(`${c.meanPromptTokens.toFixed(0)}/${c.meanCompletionTokens.toFixed(0)}`, 14)}${c.meanMs === null ? '-' : c.meanMs.toFixed(0)}`,
    );
  }
  lines.push('');
  lines.push(`OVERALL ANSWER MATCH   ${fmt(r.overall.answerMatch)}   threshold ≥ ${r.minMatch.toFixed(2)}   ${r.answerMatchPassed ? 'PASS' : 'FAIL'}`);
  lines.push(`CITATION VALIDITY      ${fmt(r.overall.citationValidity)}   required = 1.000   ${r.overall.citationValidity === 1 ? 'PASS' : 'FAIL'}`);
  lines.push(`SENSITIVE LEAKS        ${r.overall.sensitiveLeaks}   required = 0   ${r.overall.sensitiveLeaks === 0 ? 'PASS' : 'FAIL'}`);
  const failing = r.perQuestion.filter((q) => !q.answerMatch || q.citationValidity < 1 || q.sensitiveLeak);
  if (failing.length > 0) {
    lines.push('');
    lines.push('FAILING QUESTIONS:');
    for (const q of failing) {
      lines.push(`  ${q.id} (${q.category}): ${q.notes.join('; ') || (q.citationValidity < 1 ? 'invalid citation' : 'sensitive leak')}`);
    }
  }
  return lines.join('\n');
}

/** `answers.md`: every question, its answer text and its per-question numbers — for reading, not for scripts. */
export function formatAnswersMarkdown(
  report: AskEvalReport,
  answers: ReadonlyMap<string, { question: string; content: string }>,
): string {
  const lines: string[] = [`# Ask evaluation answers\n`, `Run at ${report.runAt}, model \`${report.model ?? '-'}\`.\n`];
  for (const q of report.perQuestion) {
    const a = answers.get(q.id);
    lines.push(`## ${q.id} (${q.category})`);
    if (a) lines.push(`\n**Q:** ${a.question}\n\n**A:** ${a.content}\n`);
    lines.push(
      `_citationValidity=${fmt(q.citationValidity)} cited=${q.cited} citeFromHit=${q.citeFromHit} answerMatch=${q.answerMatch} entityRecall=${fmt(
        q.entityRecall,
      )} sensitiveLeak=${q.sensitiveLeak} steps=${q.steps} toolCalls=${q.toolCalls} tokens=${q.promptTokens}/${q.completionTokens}${
        q.ms !== null ? ` ms=${q.ms}` : ''
      }_`,
    );
    if (q.notes.length > 0) lines.push(`\n> ${q.notes.join('\n> ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
