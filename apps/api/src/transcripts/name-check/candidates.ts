// =============================================================================
// Name-correction candidate retrieval — stage 1 (issue #328, epic #326)
// =============================================================================
//
// After a user renames speaker "A" to "Oscar", the ASR text still says what the
// provider heard: "Skar", "Oh scar", "Oscars". This module finds the spans that
// PLAUSIBLY are a mis-hearing of a name the user has told us about. It does not
// decide; stage 2 hands every candidate to an LLM for verification, so this
// stage leans towards recall while keeping the noise bounded enough that the
// verification prompt stays small.
//
// PURE, like `../editing/`: no Prisma, no `@Injectable`, no randomness, no
// clock. The same segments and names always yield the same candidates in the
// same order, which is what lets stage 2 cache and a test pin the output.
//
// -----------------------------------------------------------------------------
// THE PIPELINE, PER SEGMENT
// -----------------------------------------------------------------------------
//
//   1. Tokenize into word tokens with their UTF-16 offsets into `text`.
//   2. Slide windows of 1..3 consecutive tokens (never across segments).
//   3. Drop a window that already IS a name — spelled exactly (case- and
//      diacritic-insensitively) like ANY target, or that name's plural or
//      possessive ("Oscar's", "Oscars"). A correctly spelled other name is
//      never a candidate for this one. A multi-token window containing such a
//      token is dropped too: the misspelled neighbour is still reachable as a
//      window of its own, and a candidate must never ask to rewrite a name
//      that is already right.
//   4. Gate: the window's letter count must be within ±50% of the target's,
//      and EITHER its Double Metaphone keys are close to the target's (any
//      primary/alternate pair within Levenshtein 1 when the shorter key has at
//      least 3 symbols, equal when shorter) OR the letter-level Jaro-Winkler of
//      the normalized forms is at least 0.85. Because Double Metaphone drops
//      every vowel, a phonetic match additionally needs a modest amount of
//      letter agreement (see `similarity`), and a window split differently
//      from the name ("Oh scar" for "Oscar") needs an exact key. Runs of
//      function words ("that is") are never windows.
//   5. Score, then keep the best-scoring non-overlapping windows (greedy).
//
// Distinct window forms are memoised: a two-hour transcript has ~30k tokens
// but far fewer distinct 1..3-token spellings, and whether a spelling
// resembles a name does not depend on where it occurs.

import { doubleMetaphone, jaroWinkler, levenshtein, normalizeForPhonetic, normalizeName } from './phonetic';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** Precomputed comparison forms for one name. Build with {@link buildTargets}. */
export interface NameTarget {
  /** The name as the user wrote it — what a candidate proposes to write. */
  text: string;
  /** The name's word tokens, as written. */
  tokens: string[];
  /** Precomputed comparison keys. Treat as opaque. */
  keys: TargetKeys;
}

export interface TargetKeys {
  /** {@link normalizeName} of the whole name (tokens concatenated). */
  norm: string;
  /** `norm` first, then any sound-alike respellings, each with its Double Metaphone keys. */
  spellings: Spelling[];
  /** Per-token normalized forms (multi-token names). */
  tokenNorms: string[];
  /** Per-token spellings, parallel to `tokenNorms`. */
  tokenSpellings: Spelling[][];
}

export interface Spelling {
  norm: string;
  phonetic: string[];
  /** A rule-derived respelling rather than the name as written. */
  variant: boolean;
}

export interface CandidateWord {
  /** Word text as the provider returned it (punctuation allowed). */
  t: string;
  /** Provider confidence in `[0, 1]`, or `null` when unknown. */
  c: number | null;
}

export interface CandidateSegment {
  id: string;
  rev: number;
  speakerId: string;
  startMs: number;
  text: string;
  words?: CandidateWord[];
}

export interface NameCandidateSignals {
  /** Letter-level Jaro-Winkler against the target spelling that matched best. */
  jaroWinkler: number;
  /**
   * `exact` = a phonetic key pair is equal; `near` = one confusable-sound
   * edit apart; `weak` = one other edit apart; `null` = matched on letters only.
   */
  phonetic: PhoneticRelation | null;
  /** How the window was compared: as one concatenated form, or token by token against a multi-token name. */
  comparison: 'concatenated' | 'tokenwise';
  /** Number of tokens in the window (1..3). */
  tokenCount: number;
  /** Lowest provider confidence among the window's aligned words, `null` when none were aligned. */
  minConfidence: number | null;
  /** Whether the low-confidence bonus was applied. */
  lowConfidence: boolean;
  /** Whether the window is a single very common function word (penalised). */
  stopword: boolean;
}

export interface NameCandidate {
  segmentId: string;
  segmentRev: number;
  /** UTF-16 offset into the segment's `text`, inclusive. */
  start: number;
  /** UTF-16 offset into the segment's `text`, exclusive. */
  end: number;
  /** `text.slice(start, end)` — the span as it currently reads. */
  original: string;
  /** The name the span may be a mis-hearing of (`NameTarget.text`). */
  target: string;
  /** In `[0, 1]`; higher is more likely. */
  score: number;
  signals: NameCandidateSignals;
}

export interface FindCandidatesOptions {
  /** Minimum score to report. Default {@link DEFAULT_MIN_SCORE}. */
  minScore?: number;
  /** Cap on the total reported; the highest scores are kept. Default 2000. */
  maxCandidates?: number;
  /** Largest window, in tokens (1..3). Default 3. */
  maxWindowTokens?: number;
}

export interface FindCandidatesResult {
  candidates: NameCandidate[];
  /** True when more than `maxCandidates` passed and the lowest-scoring were dropped. */
  truncated: boolean;
  scannedSegments: number;
  scannedTokens: number;
}

// -----------------------------------------------------------------------------
// Tuning
// -----------------------------------------------------------------------------

export const DEFAULT_MIN_SCORE = 0.72;
export const DEFAULT_MAX_CANDIDATES = 2000;
export const MAX_TARGETS = 200;

/** Phonetic keys are longer than the reference 4 so long names keep their tail. */
const PHONETIC_KEY_LENGTH = 8;
/** Letter-only gate. */
const JW_GATE = 0.85;
/** Minimum letter similarity for a rule-derived respelling to count at all. */
const VARIANT_JW_FLOOR = 0.75;
/** Weight of the phonetic similarity in a phonetically gated score. */
const PHONETIC_WEIGHT = 0.55;
const PHONETIC_SCORE: Record<PhoneticRelation, number> = { exact: 1, near: 0.85, weak: 0.75 };
/** Minimum letter-level Jaro-Winkler for each strength of phonetic match. */
const PHONETIC_JW_FLOOR: Record<PhoneticRelation, number> = { exact: 0.7, near: 0.65, weak: 0.72 };
/** A window split differently from the name ("Oh scar" / "Oscar") needs an exact key and this much letter agreement. */
const SPLIT_JW_FLOOR = 0.8;
/** The loosest letter floor of any path — below it nothing can pass, so the phonetic keys are never built. */
const MIN_JW_ANY_PATH = Math.min(JW_GATE, SPLIT_JW_FLOOR, ...Object.values(PHONETIC_JW_FLOOR));
/** Confidence below which the provider's own doubt counts as evidence. */
const LOW_CONFIDENCE = 0.6;
const STOPWORD_PENALTY = 0.35;
/** A multi-token window starting or ending on a function word ("the scar"). */
const EDGE_STOPWORD_PENALTY = 0.05;
/** A multi-token window matched against a multi-token name covers the whole name. */
const FULL_NAME_BONUS = 0.02;
/** Names shorter than this (after normalization) are never fuzzily matched — "Al" would match every "all". */
const MIN_FUZZY_TARGET_LETTERS = 3;

const GENERIC_NAME = [/^speaker\s*[a-z0-9]+$/i, /^unknown/i];

/** Very common English/Spanish function words and fillers. Compared after {@link normalizeName}. */
const STOPWORDS = new Set([
  'the', 'and', 'a', 'to', 'of', 'in', 'is', 'it', 'you', 'that', 'he', 'she', 'we', 'they', 'so',
  'de', 'la', 'el', 'que', 'y', 'en', 'un', 'una', 'los', 'las', 'por', 'con', 'para', 'es', 'lo',
  'se', 'no', 'si', 'me', 'mi', 'tu', 'su', 'oh', 'uh', 'um', 'ok', 'yeah', 'yes',
  // A few more of the same kind: two-letter words JW rates highly against any
  // three-letter name that shares their letters.
  'an', 'as', 'at', 'be', 'on', 'or', 'i', 'my', 'al', 'del', 'le', 'te', 'ya', 'ah', 'eh',
]);

// -----------------------------------------------------------------------------
// Tokenization
// -----------------------------------------------------------------------------

/**
 * A word token: a maximal run of letters, digits and combining marks, with
 * internal apostrophes and hyphens ("O'Brien", "Jean-Luc", "Oscar's"). Leading
 * and trailing punctuation is outside the token, so offsets never include it.
 */
const TOKEN = /[\p{L}\p{N}\p{M}]+(?:['’\-‐][\p{L}\p{N}\p{M}]+)*/gu;

export interface Token {
  text: string;
  start: number;
  end: number;
  norm: string;
}

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m !== null; m = TOKEN.exec(text)) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length, norm: normalizeName(m[0]) });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Targets
// -----------------------------------------------------------------------------

function keysOf(s: string): string[] {
  const norm = normalizeForPhonetic(s);
  if (!norm) return [];
  const [p, a] = doubleMetaphone(norm, PHONETIC_KEY_LENGTH);
  const keys: string[] = [];
  if (p) keys.push(p);
  if (a && a !== p) keys.push(a);
  return keys;
}

/**
 * Sound-alike respellings a name is also compared as. Deliberately tiny and
 * rule-based: `gu` before a vowel is /w/ in Spanish and Vietnamese
 * ("Nguyen" → "nwyen", "Guadalupe" → "wadalupe"), which Double Metaphone
 * encodes as a hard G.
 */
function spellingsOf(norm: string): Spelling[] {
  const out: Spelling[] = [{ norm, phonetic: keysOf(norm), variant: false }];
  const gu = norm.replace(/gu(?=[aeiouy])/g, 'w');
  if (gu !== norm) out.push({ norm: gu, phonetic: keysOf(gu), variant: true });
  return out;
}

function makeTarget(text: string, tokens: string[]): NameTarget {
  const tokenNorms = tokens.map((t) => normalizeName(t));
  const norm = tokenNorms.join('');
  return {
    text,
    tokens,
    keys: { norm, spellings: spellingsOf(norm), tokenNorms, tokenSpellings: tokenNorms.map((t) => spellingsOf(t)) },
  };
}

/**
 * Build comparison targets from speaker display names and user-supplied terms.
 *
 * Each full name is a target, and so is every token of at least three
 * characters of a multi-word name ("Oscar Marín" → "Oscar Marín", "Oscar",
 * "Marín"). Generic labels ("Speaker A", "Unknown") are dropped, duplicates are
 * removed case- and diacritic-insensitively (first spelling wins), and the list
 * is capped at {@link MAX_TARGETS}.
 */
export function buildTargets(names: string[]): NameTarget[] {
  const seen = new Set<string>();
  const out: NameTarget[] = [];

  const push = (text: string, tokens: string[]): void => {
    if (out.length >= MAX_TARGETS) return;
    const target = makeTarget(text, tokens);
    if (!target.keys.norm || seen.has(target.keys.norm)) return;
    seen.add(target.keys.norm);
    out.push(target);
  };

  for (const raw of names) {
    const text = raw.trim().replace(/\s+/g, ' ');
    if (!text || GENERIC_NAME.some((re) => re.test(text))) continue;
    const tokens = tokenize(text).map((t) => t.text);
    if (tokens.length === 0) continue;
    push(text, tokens);
    if (tokens.length > 1) {
      for (const tok of tokens) {
        if ([...tok].length >= 3) push(tok, [tok]);
      }
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Comparison
// -----------------------------------------------------------------------------

export type PhoneticRelation = 'exact' | 'near' | 'weak';

/**
 * Consonant symbols of a Double Metaphone key that ASR (and people) confuse
 * with one another: labials, dentals, sibilants, nasals.
 */
const CONFUSABLE: ReadonlyArray<string> = ['PF', 'T0', 'SX', 'XJ', 'MN'];

function confusable(a: string, b: string): boolean {
  return CONFUSABLE.some((pair) => pair.includes(a) && pair.includes(b));
}

/**
 * Classify a one-edit difference between two phonetic keys. A substitution
 * between confusable sounds (Siobhan XPN / Shivon XFN) or losing the key's
 * leading vowel marker (Oscar ASKR / Skar SKR) is `near`; any other single
 * edit (Bartholomew PRTLM / problem PRPLM) is only `weak`.
 */
function oneEditKind(x: string, y: string): 'near' | 'weak' {
  if (x.length === y.length) {
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) return confusable(x[i]!, y[i]!) ? 'near' : 'weak';
    }
    return 'near';
  }
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  const dropped = long[i]!;
  return (i === 0 && dropped === 'A') || dropped === 'H' ? 'near' : 'weak';
}

/** Best phonetic relation between two key sets. */
function phoneticRelation(a: string[], b: string[]): PhoneticRelation | null {
  let best: PhoneticRelation | null = null;
  for (const x of a) {
    for (const y of b) {
      if (x === y) return 'exact';
      if (best === 'near') continue;
      if (x.length >= 3 && y.length >= 3 && levenshtein(x, y, 1) <= 1) {
        best = oneEditKind(x, y) === 'near' ? 'near' : (best ?? 'weak');
      }
    }
  }
  return best;
}

interface Similarity {
  jw: number;
  phonetic: PhoneticRelation | null;
  base: number;
}

/**
 * Gate + base score for one normalized form against a target's spellings; the
 * best spelling wins.
 *
 * A phonetic match alone is not enough: Double Metaphone collapses vowels, so
 * "again" and "Joaquín" share a key, and so do "clear" and "Guillermo" to
 * within one edit. Each phonetic relation therefore also needs a minimum of
 * letter agreement (`*_JW_FLOOR`), looser the stronger the phonetic evidence.
 * A respelling ({@link spellingsOf}) additionally needs `VARIANT_JW_FLOOR`:
 * its whole purpose is to let "Nwin" reach "Nguyen", and on the phonetic key
 * alone it would also let every "nine", "none" and "noon" through.
 *
 * `split` marks a window whose token count differs from the name's ("Oh scar"
 * for "Oscar"): only an exact phonetic match with strong letter agreement
 * counts, or every pair of short words would resemble some name.
 */
function similarity(norm: string, keys: () => string[], spellings: Spelling[], split: boolean): Similarity | null {
  let best: Similarity | null = null;
  for (const sp of spellings) {
    // Letters first. Every path below needs at least MIN_JW_ANY_PATH of letter
    // agreement, and Jaro-Winkler is several times cheaper than encoding the
    // window phonetically — most windows are rejected here, keys never built.
    const jw = jaroWinkler(sp.norm, norm);
    if (jw < (split ? SPLIT_JW_FLOOR : sp.variant ? VARIANT_JW_FLOOR : MIN_JW_ANY_PATH)) continue;
    const phonetic = phoneticRelation(keys(), sp.phonetic);
    if (split) {
      if (phonetic !== 'exact') continue;
    } else if (phonetic === null) {
      if (jw < JW_GATE) continue;
    } else if (jw < PHONETIC_JW_FLOOR[phonetic]) {
      continue;
    }
    const base = phonetic === null ? jw : PHONETIC_WEIGHT * PHONETIC_SCORE[phonetic] + (1 - PHONETIC_WEIGHT) * jw;
    if (!best || base > best.base) best = { jw, phonetic, base };
  }
  return best;
}

function withinLength(windowLetters: number, targetLetters: number): boolean {
  return windowLetters >= targetLetters * 0.5 && windowLetters <= targetLetters * 1.5;
}

interface WindowMatch {
  targetIndex: number;
  sim: Similarity;
  comparison: 'concatenated' | 'tokenwise';
}

/**
 * The best target for one window form, or `null`. `tokenNorms` are the
 * window's per-token normalized forms (for the token-wise comparison against a
 * multi-token name).
 */
function matchWindow(
  norm: string,
  tokenNorms: string[],
  targets: NameTarget[],
  keyCache: Map<string, string[]>,
): WindowMatch | null {
  let keys: string[] | undefined;
  // Single tokens repeat constantly and are cached; a multi-token form rarely
  // repeats, so caching it would only grow the map.
  const windowKeys = (): string[] => (keys ??= tokenNorms.length === 1 ? cachedKeys(norm, keyCache) : keysOf(norm));
  let best: WindowMatch | null = null;
  const letters = norm.length;
  const n = tokenNorms.length;

  for (let ti = 0; ti < targets.length; ti++) {
    const t = targets[ti]!.keys;
    if (t.norm.length < MIN_FUZZY_TARGET_LETTERS) continue;
    const tokenCount = t.tokenNorms.length;

    let cand: WindowMatch | null = null;

    if (withinLength(letters, t.norm.length)) {
      const sim = similarity(norm, windowKeys, t.spellings, n !== tokenCount);
      if (sim) cand = { targetIndex: ti, sim, comparison: 'concatenated' };
    }

    // Token-wise: a window with as many tokens as a multi-token name, every
    // token of which passes the gate against its counterpart.
    if (n > 1 && n === tokenCount) {
      let jwSum = 0;
      let baseSum = 0;
      let worst: PhoneticRelation | null = 'exact';
      let ok = true;
      for (let i = 0; i < n; i++) {
        const wn = tokenNorms[i]!;
        if (!wn || !withinLength(wn.length, t.tokenNorms[i]!.length)) {
          ok = false;
          break;
        }
        const s = similarity(wn, () => cachedKeys(wn, keyCache), t.tokenSpellings[i]!, false);
        if (!s) {
          ok = false;
          break;
        }
        jwSum += s.jw;
        baseSum += s.base;
        worst = weaker(worst, s.phonetic);
      }
      if (ok) {
        const sim: Similarity = { jw: jwSum / n, phonetic: worst, base: baseSum / n };
        if (!cand || sim.base > cand.sim.base) cand = { targetIndex: ti, sim, comparison: 'tokenwise' };
      }
    }

    if (cand && tokenCount > 1 && n > 1) {
      cand = { ...cand, sim: { ...cand.sim, base: cand.sim.base + FULL_NAME_BONUS } };
    }
    if (cand && (!best || cand.sim.base > best.sim.base)) best = cand;
  }
  return best;
}

const RELATION_RANK: Record<PhoneticRelation, number> = { exact: 3, near: 2, weak: 1 };

function weaker(a: PhoneticRelation | null, b: PhoneticRelation | null): PhoneticRelation | null {
  if (a === null || b === null) return null;
  return RELATION_RANK[a] <= RELATION_RANK[b] ? a : b;
}

function cachedKeys(norm: string, cache: Map<string, string[]>): string[] {
  let k = cache.get(norm);
  if (!k) {
    k = keysOf(norm);
    cache.set(norm, k);
  }
  return k;
}

// -----------------------------------------------------------------------------
// Word-confidence alignment
// -----------------------------------------------------------------------------

/**
 * For each token, the confidence of the provider word it aligns to (or
 * `undefined`). Alignment walks both lists in order, matching normalized text
 * and looking a few words ahead to resynchronise after a mismatch; a token
 * that cannot be aligned simply carries no confidence.
 */
function alignConfidences(tokens: Token[], words: CandidateWord[] | undefined): Array<number | null | undefined> {
  const out: Array<number | null | undefined> = new Array(tokens.length).fill(undefined);
  if (!words || words.length === 0) return out;
  const wordNorms = words.map((w) => normalizeName(w.t));
  const LOOKAHEAD = 3;
  let wi = 0;
  for (let ti = 0; ti < tokens.length && wi < words.length; ti++) {
    const tn = tokens[ti]!.norm;
    if (!tn) continue;
    for (let k = 0; k <= LOOKAHEAD && wi + k < words.length; k++) {
      if (wordNorms[wi + k] === tn) {
        out[ti] = words[wi + k]!.c;
        wi = wi + k + 1;
        break;
      }
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Retrieval
// -----------------------------------------------------------------------------

interface Pending {
  order: number;
  candidate: NameCandidate;
}

/**
 * Find spans in `segments` that may be mis-hearings of `targets`.
 *
 * Output order is deterministic: segments in the order given, then by start
 * offset. At most one candidate covers any character of a segment.
 */
export function findCandidates(
  segments: CandidateSegment[],
  targets: NameTarget[],
  opts: FindCandidatesOptions = {},
): FindCandidatesResult {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const maxWindow = Math.max(1, Math.min(3, opts.maxWindowTokens ?? 3));

  // Everything spelled exactly like a name — and its plural/possessive — is
  // never a candidate, for any target.
  const exact = new Set<string>();
  for (const t of targets) exact.add(t.keys.norm);
  const isExact = (norm: string): boolean =>
    exact.has(norm) || (norm.length > 1 && norm.endsWith('s') && exact.has(norm.slice(0, -1)));

  let maxTargetLetters = 0;
  for (const t of targets) maxTargetLetters = Math.max(maxTargetLetters, t.keys.norm.length);
  const maxWindowLetters = maxTargetLetters * 1.5;

  const memo = new Map<string, WindowMatch | null>();
  const keyCache = new Map<string, string[]>();

  const all: Pending[] = [];
  let scannedTokens = 0;
  let order = 0;

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]!;
    const tokens = tokenize(seg.text);
    scannedTokens += tokens.length;
    if (tokens.length === 0 || targets.length === 0) continue;

    const confidences = alignConfidences(tokens, seg.words);
    const tokenExact = tokens.map((t) => t.norm !== '' && isExact(t.norm));
    const found: NameCandidate[] = [];

    for (let i = 0; i < tokens.length; i++) {
      let norm = '';
      let letters = 0;
      let allStop = true;
      const tokenNorms: string[] = [];
      for (let w = 1; w <= maxWindow && i + w - 1 < tokens.length; w++) {
        const j = i + w - 1;
        const tok = tokens[j]!;
        // A window never swallows a correctly spelled name, and never begins
        // or ends on a token with no letters.
        if (tokenExact[j]) break;
        norm += tok.norm;
        letters += tok.norm.length;
        tokenNorms.push(tok.norm);
        allStop = allStop && STOPWORDS.has(tok.norm);
        if (letters > maxWindowLetters) break;
        if (!tok.norm || !tokens[i]!.norm) continue;
        if (isExact(norm)) continue;
        // "that is", "so the": a run of function words is never a name.
        if (w > 1 && allStop) continue;

        // Whether a spelling resembles a name does not depend on where it
        // occurs, so single tokens — which repeat constantly — are memoised.
        let match = w === 1 ? memo.get(norm) : undefined;
        if (match === undefined) {
          match = matchWindow(norm, tokenNorms, targets, keyCache);
          if (w === 1) memo.set(norm, match);
        }
        if (!match) continue;

        const target = targets[match.targetIndex]!;
        const stopword = w === 1 && STOPWORDS.has(norm);
        const edgeStop = w > 1 && (STOPWORDS.has(tokenNorms[0]!) || STOPWORDS.has(tokenNorms[w - 1]!));

        let minConfidence: number | null = null;
        for (let k = i; k <= j; k++) {
          const c = confidences[k];
          if (typeof c === 'number' && (minConfidence === null || c < minConfidence)) minConfidence = c;
        }
        const lowConfidence = minConfidence !== null && minConfidence < LOW_CONFIDENCE;

        let score = match.sim.base;
        if (lowConfidence) score += 0.05 + (0.1 * (LOW_CONFIDENCE - minConfidence!)) / LOW_CONFIDENCE;
        if (stopword) score -= STOPWORD_PENALTY;
        if (edgeStop) score -= EDGE_STOPWORD_PENALTY;
        score = Math.round(Math.min(1, Math.max(0, score)) * 1e4) / 1e4;
        if (score < minScore) continue;

        const start = tokens[i]!.start;
        const end = tok.end;
        found.push({
          segmentId: seg.id,
          segmentRev: seg.rev,
          start,
          end,
          original: seg.text.slice(start, end),
          target: target.text,
          score,
          signals: {
            jaroWinkler: Math.round(match.sim.jw * 1e4) / 1e4,
            phonetic: match.sim.phonetic,
            comparison: match.comparison,
            tokenCount: w,
            minConfidence,
            lowConfidence,
            stopword,
          },
        });
      }
    }

    // Greedy non-overlapping selection: best score first; on a tie the longer
    // span (it explains more of the text), then the earlier one.
    found.sort((a, b) => b.score - a.score || b.end - b.start - (a.end - a.start) || a.start - b.start);
    const kept: NameCandidate[] = [];
    for (const c of found) {
      if (kept.every((k) => c.end <= k.start || c.start >= k.end)) kept.push(c);
    }
    kept.sort((a, b) => a.start - b.start);
    for (const c of kept) all.push({ order: order++, candidate: c });
  }

  let truncated = false;
  let selected = all;
  if (all.length > maxCandidates) {
    truncated = true;
    selected = [...all]
      .sort((a, b) => b.candidate.score - a.candidate.score || a.order - b.order)
      .slice(0, Math.max(0, maxCandidates))
      .sort((a, b) => a.order - b.order);
  }

  return {
    candidates: selected.map((p) => p.candidate),
    truncated,
    scannedSegments: segments.length,
    scannedTokens,
  };
}
