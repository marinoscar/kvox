// Pure text helpers shared by the scorer, the loader and the fixture test.

/**
 * Collapse every whitespace run to one space and trim.
 *
 * @stability experimental
 */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Whether `quote` occurs verbatim in `haystack`, after whitespace collapse on both.
 *
 * @stability experimental
 */
export function quoteFoundIn(quote: string, haystack: string): boolean {
  const q = collapseWhitespace(quote);
  return q.length > 0 && collapseWhitespace(haystack).includes(q);
}

/**
 * NFKC → lower-case → strip punctuation except an inner `'`/`-` (one joining
 * two letters/digits) → collapse whitespace. "Sarah  Chen," → "sarah chen";
 * "O'Neil-Smith" keeps both joiners.
  *
  * @stability experimental
 */
export function normalizeName(s: string): string {
  const lowered = s.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'");
  let out = '';
  for (let i = 0; i < lowered.length; i += 1) {
    const ch = lowered[i];
    if (/[\p{L}\p{N}\s]/u.test(ch)) {
      out += ch;
      continue;
    }
    if ((ch === "'" || ch === '-') && i > 0 && i < lowered.length - 1) {
      const prev = lowered[i - 1];
      const next = lowered[i + 1];
      if (/[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next)) {
        out += ch;
        continue;
      }
    }
    out += ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * The set of normalized tokens of a string.
 *
 * @param s - the string.
 * @returns its tokens.
 *
 * @stability experimental
 */
export function tokenSet(s: string): Set<string> {
  const n = normalizeName(s);
  return new Set(n.length === 0 ? [] : n.split(' '));
}

/**
 * Jaccard similarity of two token sets.
 *
 * @param a - one set.
 * @param b - the other.
 * @returns |A∩B| / |A∪B| (1 for two empty sets).
 *
 * @stability experimental
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Token-set F1: 2·|A∩B| / (|A|+|B|).
 *
 * @stability experimental
 */
export function tokenF1(a: string, b: string): number {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}
