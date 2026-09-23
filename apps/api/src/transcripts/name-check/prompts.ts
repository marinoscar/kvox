// =============================================================================
// Name-correction prompts — stages 1b and 2 (issues #328 and #330, epic #326)
// =============================================================================
//
// `candidates.ts` is stage 1: a deterministic, phonetic retrieval pass that
// leans towards recall. This file is everything the `transcript.name_check`
// job says to, and reads back from, a language model:
//
//   • DISCOVERY (thorough mode only, #330) — the transcript is packed into
//     chunks of roughly {@link DISCOVERY_CHUNK_TOKENS} and the model is asked
//     for spans that are probably mis-hearings of the listed names. It finds
//     what a phonetic key cannot ("Oscar" heard as "the scar"), at the price of
//     reading the whole transcript.
//   • ADJUDICATION (both modes) — every candidate, from either source, is shown
//     to the model with its neighbouring lines and the span marked, and the
//     model answers `replace` or `keep`. Nothing reaches the user that a model
//     did not verify in context.
//
// PURE, like `candidates.ts` and `../editing/`: no Prisma, no `@Injectable`, no
// clock, no randomness. Token counting is injected as a function so this file
// never learns which provider it is talking to, and so the request-time
// estimate (`TranscriptNameCheckService`) and the job run the SAME packing and
// the SAME prompt text — an estimate computed from a second copy of the prompt
// would drift from the bill the first time either was edited.
//
// ⚠ THE MODEL'S OUTPUT IS UNTRUSTED INPUT. It is asked for JSON (and the
// provider is asked to constrain it to JSON), but a hint is not a guarantee —
// see `AiGenerateRequest.responseFormat`. Everything below parses defensively,
// validates with Zod, and then applies guards of its own: a `replace` verdict
// whose replacement is not the target (modulo a possessive or plural) is
// dropped, however confident the model claims to be. The model may only ever
// choose BETWEEN "the name the user told us about" and "leave it alone".
// =============================================================================

import { z } from 'zod';

import type { CandidateSegment, NameCandidate, NameTarget } from './candidates';
import { normalizeName } from './phonetic';

// -----------------------------------------------------------------------------
// Tuning
// -----------------------------------------------------------------------------

/** Target size of one discovery chunk's transcript text, in tokens. */
export const DISCOVERY_CHUNK_TOKENS = 6_000;

/** Candidates per adjudication request. */
export const ADJUDICATION_BATCH_SIZE = 40;

/**
 * The most candidates one run adjudicates, highest score first.
 *
 * A bound on the user's bill rather than on quality: past a thousand
 * candidates the targets are almost certainly too generic ("Al", "Mo") and the
 * right fix is a better term list, not twenty-five more requests.
 */
export const MAX_ADJUDICATED_CANDIDATES = 1_000;

/**
 * The nominal score a discovery finding ranks at against phonetic candidates
 * when the cap above has to choose. Below a confident phonetic match, above a
 * marginal one: the model read the context, the phonetic pass did not.
 */
export const DISCOVERY_SCORE = 0.8;

/** Characters of the candidate's own line shown on each side of the span. */
const LINE_CONTEXT_CHARS = 240;
/** Characters of the previous / next line shown. */
const NEIGHBOUR_CONTEXT_CHARS = 200;

/** The marks around the span under review. Unusual enough never to be in ASR text. */
export const SPAN_OPEN = '⟦';
export const SPAN_CLOSE = '⟧';

/** Appended to the user message on the one retry a malformed answer earns. */
export const JSON_RETRY_LINE = 'Return only valid JSON matching the schema.';

// -----------------------------------------------------------------------------
// Shared shapes
// -----------------------------------------------------------------------------

/** What a prompt is. The provider call needs exactly these two strings. */
export interface NameCheckPrompt {
  systemPrompt: string;
  userContent: string;
}

/** Counts tokens the way the active provider does. */
export type CountTokens = (text: string) => number;

/** A candidate with where it came from. */
export interface SourcedCandidate extends NameCandidate {
  source: 'phonetic' | 'discovery';
}

/** Speaker id → the name the transcript shows for them. */
export type SpeakerNames = ReadonlyMap<string, string>;

function speakerName(names: SpeakerNames, speakerId: string): string {
  return names.get(speakerId) ?? 'Unknown speaker';
}

/** The target list as the prompts print it: one per line, quoted. */
function formatTargets(targets: readonly NameTarget[]): string {
  return targets.map((t) => `- ${JSON.stringify(t.text)}`).join('\n');
}

// -----------------------------------------------------------------------------
// Robust JSON extraction
// -----------------------------------------------------------------------------

/**
 * The first JSON object in a model's answer, or `null`.
 *
 * TOTAL AND NEVER THROWS. Tolerates the three habits JSON mode does not always
 * suppress: a Markdown code fence, a sentence of preamble, and trailing prose.
 */
export function extractJsonObject(answer: string): unknown {
  const unfenced = answer.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Discovery (thorough mode, #330)
// -----------------------------------------------------------------------------

export const DISCOVERY_SYSTEM_PROMPT = [
  'You find speech-recognition errors in names.',
  '',
  'You are given part of a transcript, one segment per line as "[<n>] <Speaker>: <text>", and a list of',
  'names and terms that occur in this conversation. Find spans of text that are probably',
  'mis-transcriptions of one of the listed names or terms — for example "Skar" or "Oh scar" for "Oscar".',
  '',
  'Rules:',
  '- Report a span only when it is very likely a mis-hearing of a listed name or term in its context.',
  '- Never report text that already spells the name or term correctly.',
  '- Never report ordinary words used in their normal meaning (for example "scar tissue").',
  '- "seg" is the number in square brackets at the start of the line the span is on.',
  '- "text" must be copied exactly as it appears in that line, character for character, and be as short',
  '  as possible: only the mis-heard words.',
  '- "target" must be exactly one of the listed names or terms.',
  '',
  'Respond with JSON only, in this shape: {"findings":[{"seg":<n>,"text":"...","target":"..."}]}.',
  'If there are none, respond {"findings":[]}.',
].join('\n');

/** One rendered transcript line. `index` is the segment's index in the whole run. */
export function renderDiscoveryLine(index: number, segment: CandidateSegment, names: SpeakerNames): string {
  const text = segment.text.replace(/\s+/g, ' ').trim();
  return `[${index}] ${speakerName(names, segment.speakerId)}: ${text}`;
}

/** One discovery request's worth of segments, by index into the run's segment list. */
export interface DiscoveryChunk {
  /** Indices into the segment list, ascending and contiguous. */
  indices: number[];
  /** The rendered lines, joined. */
  text: string;
  /** Tokens of `text` alone. */
  tokens: number;
}

/**
 * Pack the transcript into discovery chunks of about `maxTokens` each.
 *
 * Greedy, in reading order, with ONE SEGMENT OF OVERLAP: each chunk after the
 * first starts with the previous chunk's last segment, so a mis-hearing whose
 * context straddles the seam ("…said Oh" / "scar was right…") is seen whole at
 * least once. A finding reported twice for the overlapping segment is
 * de-duplicated by span when the findings are located.
 *
 * A single segment longer than `maxTokens` is a chunk on its own rather than
 * being cut: the model needs the whole line to quote from it exactly.
 */
export function packDiscoveryChunks(
  segments: readonly CandidateSegment[],
  names: SpeakerNames,
  countTokens: CountTokens,
  maxTokens: number = DISCOVERY_CHUNK_TOKENS,
): DiscoveryChunk[] {
  const lines = segments.map((s, i) => renderDiscoveryLine(i, s, names));
  // +1 for the newline that joins it to the next line.
  const costs = lines.map((l) => countTokens(l) + 1);
  const chunks: DiscoveryChunk[] = [];

  let i = 0;
  while (i < segments.length) {
    const indices: number[] = [];
    let tokens = 0;
    let j = i;
    while (j < segments.length && (indices.length === 0 || tokens + costs[j]! <= maxTokens)) {
      if (segments[j]!.text.trim().length > 0) {
        indices.push(j);
        tokens += costs[j]!;
      }
      j++;
    }
    if (indices.length > 0) {
      chunks.push({ indices, text: indices.map((k) => lines[k]!).join('\n'), tokens });
    }
    if (j >= segments.length) break;
    // One segment of overlap — but never zero progress.
    i = Math.max(i + 1, j - 1);
  }
  return chunks;
}

export function buildDiscoveryPrompt(chunk: DiscoveryChunk, targets: readonly NameTarget[]): NameCheckPrompt {
  return {
    systemPrompt: DISCOVERY_SYSTEM_PROMPT,
    userContent: `Names and terms:\n${formatTargets(targets)}\n\nTranscript:\n${chunk.text}`,
  };
}

const discoveryEnvelopeSchema = z.object({ findings: z.array(z.unknown()) });

const discoveryFindingSchema = z.object({
  seg: z.coerce.number().int().nonnegative(),
  text: z.string().min(1).max(300),
  target: z.string().min(1).max(200),
});

export type DiscoveryFinding = z.infer<typeof discoveryFindingSchema>;

/**
 * The findings in a discovery answer, or `null` when the answer is not the
 * expected envelope at all (the cue for the one retry).
 *
 * A malformed ITEM inside a well-formed envelope is dropped on its own rather
 * than failing the whole answer: one bad row is not evidence the other forty
 * are wrong.
 */
export function parseDiscoveryAnswer(answer: string): DiscoveryFinding[] | null {
  const envelope = discoveryEnvelopeSchema.safeParse(extractJsonObject(answer));
  if (!envelope.success) return null;
  const out: DiscoveryFinding[] = [];
  for (const item of envelope.data.findings) {
    const parsed = discoveryFindingSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Matches a target by name, case- and diacritic-insensitively. */
export function findTarget(targets: readonly NameTarget[], name: string): NameTarget | undefined {
  const norm = normalizeName(name);
  if (!norm) return undefined;
  return targets.find((t) => t.keys.norm === norm);
}

/** A word token's span: letters, digits, marks, with internal apostrophes/hyphens. */
const WORD = /[\p{L}\p{N}\p{M}]+(?:['’\-‐][\p{L}\p{N}\p{M}]+)*/gu;

/** Widen `[start, end)` to the word tokens it touches, so a partial word is never replaced. */
function widenToWords(text: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  WORD.lastIndex = 0;
  for (let m = WORD.exec(text); m !== null; m = WORD.exec(text)) {
    const ms = m.index;
    const me = m.index + m[0].length;
    if (me <= start) continue;
    if (ms >= end) break;
    s = Math.min(s, ms);
    e = Math.max(e, me);
  }
  return [s, e];
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Every occurrence of `needle` in `text`, exact first, then case-insensitive. */
function occurrences(text: string, needle: string): number[] {
  const find = (hay: string, n: string): number[] => {
    const out: number[] = [];
    for (let at = hay.indexOf(n); at >= 0; at = hay.indexOf(n, at + 1)) out.push(at);
    return out;
  };
  const exact = find(text, needle);
  if (exact.length > 0) return exact;
  // Lower-casing is only offset-preserving when it does not change length.
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return [];
  return find(lower, needle.toLowerCase());
}

/**
 * Turn discovery findings into candidates: locate each `text` in its segment
 * (the first occurrence not already covered by an earlier finding), widen it
 * to whole words, and drop anything that cannot be located, names an unknown
 * target, or already spells its target.
 */
export function locateDiscoveryFindings(
  findings: readonly DiscoveryFinding[],
  segments: readonly CandidateSegment[],
  targets: readonly NameTarget[],
  already: readonly SourcedCandidate[] = [],
): SourcedCandidate[] {
  const out: SourcedCandidate[] = [];
  const bySegment = new Map<string, Array<{ start: number; end: number }>>();
  for (const c of already) {
    const list = bySegment.get(c.segmentId) ?? [];
    list.push(c);
    bySegment.set(c.segmentId, list);
  }

  for (const f of findings) {
    const segment = segments[f.seg];
    if (!segment) continue;
    const target = findTarget(targets, f.target);
    if (!target) continue;
    const needle = f.text.trim();
    if (!needle) continue;

    const covered = bySegment.get(segment.id) ?? [];
    // Occurrences that are already whole words first ("scar" the word before
    // the "scar" inside "Oscars"), then reading order.
    const spans = occurrences(segment.text, needle)
      .map((at) => {
        const [start, end] = widenToWords(segment.text, at, at + needle.length);
        return { start, end, exact: end - start === needle.length };
      })
      .sort((a, b) => Number(b.exact) - Number(a.exact) || a.start - b.start);

    let located: { start: number; end: number } | null = null;
    for (const span of spans) {
      if (covered.some((c) => overlaps(c, span))) continue;
      // Already the name (or its possessive/plural): nothing to correct here.
      if (replacementMatchesTarget(segment.text.slice(span.start, span.end), target.text)) continue;
      located = { start: span.start, end: span.end };
      break;
    }
    if (!located) continue;

    const original = segment.text.slice(located.start, located.end);

    covered.push(located);
    bySegment.set(segment.id, covered);
    out.push({
      segmentId: segment.id,
      segmentRev: segment.rev,
      start: located.start,
      end: located.end,
      original,
      target: target.text,
      score: DISCOVERY_SCORE,
      source: 'discovery',
      signals: {
        jaroWinkler: 0,
        phonetic: null,
        comparison: 'concatenated',
        tokenCount: original.split(/\s+/).filter(Boolean).length,
        minConfidence: null,
        lowConfidence: false,
        stopword: false,
      },
    });
  }
  return out;
}

/**
 * Merge phonetic and discovery candidates: a discovery candidate overlapping
 * any phonetic one is dropped (the phonetic span is kept — its offsets were
 * computed, not quoted back by a model), and so is one overlapping an earlier
 * discovery candidate. Output is in reading order.
 */
export function mergeCandidates(
  phonetic: readonly SourcedCandidate[],
  discovery: readonly SourcedCandidate[],
  segmentOrder: ReadonlyMap<string, number>,
): SourcedCandidate[] {
  const kept: SourcedCandidate[] = [...phonetic];
  const bySegment = new Map<string, SourcedCandidate[]>();
  for (const c of phonetic) {
    const list = bySegment.get(c.segmentId) ?? [];
    list.push(c);
    bySegment.set(c.segmentId, list);
  }
  for (const d of discovery) {
    const list = bySegment.get(d.segmentId) ?? [];
    if (list.some((c) => overlaps(c, d))) continue;
    list.push(d);
    bySegment.set(d.segmentId, list);
    kept.push(d);
  }
  return kept.sort(
    (a, b) =>
      (segmentOrder.get(a.segmentId) ?? 0) - (segmentOrder.get(b.segmentId) ?? 0) || a.start - b.start,
  );
}

/**
 * The highest-scoring `max` candidates, returned in reading order, and
 * whether any were dropped.
 */
export function capCandidates(
  candidates: readonly SourcedCandidate[],
  max: number = MAX_ADJUDICATED_CANDIDATES,
): { candidates: SourcedCandidate[]; truncated: boolean } {
  if (candidates.length <= max) return { candidates: [...candidates], truncated: false };
  const ranked = candidates.map((c, order) => ({ c, order }));
  ranked.sort((a, b) => b.c.score - a.c.score || a.order - b.order);
  const kept = ranked.slice(0, max).sort((a, b) => a.order - b.order);
  return { candidates: kept.map((k) => k.c), truncated: true };
}

// -----------------------------------------------------------------------------
// Adjudication (both modes)
// -----------------------------------------------------------------------------

export const ADJUDICATION_SYSTEM_PROMPT = [
  'You are verifying speech-recognition errors in names.',
  '',
  'Each item shows one line of a transcript with a span marked like ⟦this⟧, the lines before and after',
  'it, who is speaking, and a proposed name or term ("target"). Decide whether the marked span is a',
  'mis-hearing of the target.',
  '',
  'Rules:',
  '- Answer "replace" only when the marked span is very likely a mis-hearing of the target in this context.',
  '- Otherwise answer "keep". Common words used in their normal meaning (for example "scar tissue") are "keep".',
  '- Never change anything other than the marked span.',
  '- "replacement" must be the target itself, or its possessive, plural or inflected form when the grammar',
  '  of the sentence needs it (for example "Oscar\'s"). Nothing else.',
  '- Keep the language of the transcript.',
  '- "confidence" is your probability, from 0 to 1, that "replace" is correct.',
  '- "reason" is a few words.',
  '',
  'Respond with JSON only, one result per item, in this shape:',
  '{"results":[{"id":"c1","verdict":"replace"|"keep","replacement":"...","confidence":0.0,"reason":"short"}]}',
].join('\n');

function clipStart(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `…${t.slice(t.length - max)}`;
}

function clipEnd(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** The candidate's line with its span marked, clipped around the span. */
export function markSpan(text: string, start: number, end: number, radius = LINE_CONTEXT_CHARS): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  return (
    (from > 0 ? '…' : '') +
    text.slice(from, start) +
    SPAN_OPEN +
    text.slice(start, end) +
    SPAN_CLOSE +
    text.slice(end, to) +
    (to < text.length ? '…' : '')
  );
}

/** One adjudication request: the candidates it asks about, by local id. */
export interface AdjudicationBatch {
  /** `c1`, `c2`, … → the candidate. */
  items: Map<string, SourcedCandidate>;
  prompt: NameCheckPrompt;
}

/**
 * The adjudication prompt for a list of candidates.
 *
 * Each candidate is one JSON line, so a line of transcript containing quotes,
 * brackets or newlines can never be confused with the framing around it.
 */
export function buildAdjudicationPrompt(
  candidates: readonly SourcedCandidate[],
  segments: readonly CandidateSegment[],
  segmentIndex: ReadonlyMap<string, number>,
  names: SpeakerNames,
  retry = false,
): AdjudicationBatch {
  const items = new Map<string, SourcedCandidate>();
  const lines: string[] = [];
  candidates.forEach((c, i) => {
    const id = `c${i + 1}`;
    items.set(id, c);
    const index = segmentIndex.get(c.segmentId) ?? -1;
    const segment = segments[index];
    const prev = index > 0 ? segments[index - 1] : undefined;
    const next = index >= 0 ? segments[index + 1] : undefined;
    const item = {
      id,
      target: c.target,
      speaker: segment ? speakerName(names, segment.speakerId) : 'Unknown speaker',
      before: prev ? `${speakerName(names, prev.speakerId)}: ${clipStart(prev.text, NEIGHBOUR_CONTEXT_CHARS)}` : '',
      line: segment ? markSpan(segment.text, c.start, c.end) : `${SPAN_OPEN}${c.original}${SPAN_CLOSE}`,
      after: next ? `${speakerName(names, next.speakerId)}: ${clipEnd(next.text, NEIGHBOUR_CONTEXT_CHARS)}` : '',
    };
    lines.push(JSON.stringify(item));
  });

  const speakers = [...new Set(names.values())].filter(Boolean);
  const userContent =
    (speakers.length > 0 ? `Speakers: ${speakers.map((s) => JSON.stringify(s)).join(', ')}\n\n` : '') +
    `Items (one JSON object per line):\n${lines.join('\n')}` +
    (retry ? `\n\n${JSON_RETRY_LINE}` : '');

  return { items, prompt: { systemPrompt: ADJUDICATION_SYSTEM_PROMPT, userContent } };
}

/** Split into batches of `size`, in order. */
export function batch<T>(list: readonly T[], size: number = ADJUDICATION_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const adjudicationEnvelopeSchema = z.object({ results: z.array(z.unknown()) });

const adjudicationResultSchema = z.object({
  id: z.string().min(1).max(20),
  verdict: z.enum(['replace', 'keep']),
  replacement: z.string().max(300).nullish(),
  confidence: z.coerce.number().min(0).max(1).nullish(),
  reason: z.string().max(1_000).nullish(),
});

export type AdjudicationResult = z.infer<typeof adjudicationResultSchema>;

/** The results in an adjudication answer, or `null` when the envelope is wrong. */
export function parseAdjudicationAnswer(answer: string): AdjudicationResult[] | null {
  const envelope = adjudicationEnvelopeSchema.safeParse(extractJsonObject(answer));
  if (!envelope.success) return null;
  const out: AdjudicationResult[] = [];
  for (const item of envelope.data.results) {
    const parsed = adjudicationResultSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Longest `reason` persisted. */
const MAX_REASON_CHARS = 280;

/** A suggestion ready to persist. */
export interface AcceptedSuggestion {
  candidate: SourcedCandidate;
  replacement: string;
  confidence: number | null;
  reason: string | null;
}

/**
 * Turn a batch's results into suggestions, applying the guards:
 *
 *   • only `replace` verdicts for ids this batch actually sent;
 *   • the replacement, after stripping a trailing possessive or plural, must
 *     equal the target case- and diacritic-insensitively;
 *   • the replacement must differ from what is already there;
 *   • one suggestion per candidate (a repeated id keeps the first).
 */
export function acceptResults(
  batchItems: ReadonlyMap<string, SourcedCandidate>,
  results: readonly AdjudicationResult[],
): AcceptedSuggestion[] {
  const out: AcceptedSuggestion[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.verdict !== 'replace' || seen.has(r.id)) continue;
    const candidate = batchItems.get(r.id);
    if (!candidate) continue;
    seen.add(r.id);
    const replacement = (r.replacement ?? candidate.target).replace(/\s+/g, ' ').trim();
    if (!replacement || replacement === candidate.original) continue;
    if (!replacementMatchesTarget(replacement, candidate.target)) continue;
    const reason = r.reason?.replace(/\s+/g, ' ').trim() ?? '';
    out.push({
      candidate,
      replacement,
      confidence: typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : null,
      reason: reason ? reason.slice(0, MAX_REASON_CHARS) : null,
    });
  }
  return out;
}

/** Trailing possessive / plural forms a replacement may carry beyond the target. */
const SUFFIXES = [/['’]s$/u, /['’]$/u, /es$/u, /s$/u];

/**
 * Is `replacement` the target, or the target plus a possessive or plural
 * ending, compared case- and diacritic-insensitively?
 */
export function replacementMatchesTarget(replacement: string, target: string): boolean {
  const want = normalizeName(target);
  if (!want) return false;
  const trimmed = replacement.trim();
  if (normalizeName(trimmed) === want) return true;
  return SUFFIXES.some((re) => re.test(trimmed) && normalizeName(trimmed.replace(re, '')) === want);
}
