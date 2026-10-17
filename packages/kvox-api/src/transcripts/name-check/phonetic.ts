// =============================================================================
// Phonetic + string-similarity primitives for AI name correction (issue #328)
// =============================================================================
//
// PURE. No Prisma, no `@Injectable`, no randomness, no I/O — the same
// discipline as `../editing/`. Every function here is a deterministic function
// of its arguments, so the candidate retrieval built on it
// (`./candidates.ts`) returns the same answer for the same transcript every
// time it runs.
//
// -----------------------------------------------------------------------------
// DOUBLE METAPHONE — ATTRIBUTION
// -----------------------------------------------------------------------------
//
// The Double Metaphone algorithm is by Lawrence Philips ("The Double Metaphone
// Search Algorithm", C/C++ Users Journal, June 2000). His original C++
// implementation was released into the public domain. This file is a
// TypeScript port that follows that reference implementation rule for rule
// (and its widely used public-domain/MIT-licensed descendants: Maurice Aubrey's
// C port behind Text::DoubleMetaphone and PostgreSQL's `fuzzystrmatch`
// `dmetaphone()`, and Titus Wormer's MIT-licensed `double-metaphone`). The
// comments inside `doubleMetaphone` are Philips' own examples.
//
// The port's output was checked against PostgreSQL's `dmetaphone()` /
// `dmetaphone_alt()` for every vector in `phonetic.spec.ts`.

/** Vowels as the algorithm defines them (`Y` included). */
const VOWELS = new Set(['A', 'E', 'I', 'O', 'U', 'Y']);

/**
 * Lawrence Philips' Double Metaphone.
 *
 * Returns `[primary, alternate]`. When a word has no alternate pronunciation
 * the two are equal. Both are truncated to `maxLength` (4 in the reference
 * implementation; a larger value keeps more of a long name's tail).
 *
 * The input is upper-cased but otherwise used as given — callers wanting
 * `"José"` and `"Jose"` to encode identically should pass it through
 * {@link normalizeForPhonetic} first (see {@link phoneticKeys}).
 */
export function doubleMetaphone(input: string, maxLength = 4): [string, string] {
  let primary = '';
  let secondary = '';

  const value = input.toUpperCase();
  const length = value.length;
  if (length === 0) return ['', ''];
  const last = length - 1;
  // The reference pads with five spaces so look-aheads never run off the end.
  const original = value + '     ';

  const getAt = (i: number): string => (i < 0 ? '' : (original[i] ?? ''));
  const stringAt = (start: number, len: number, ...list: string[]): boolean => {
    if (start < 0) return false;
    const sub = original.substr(start, len);
    return list.includes(sub);
  };
  const isVowel = (i: number): boolean => i >= 0 && i < length && VOWELS.has(original[i]!);

  const slavoGermanic =
    value.includes('W') || value.includes('K') || value.includes('CZ') || value.includes('WITZ');

  /**
   * Philips' `MetaphAdd`. One argument appends to both keys. Two arguments
   * append `main` to the primary and `alt` to the alternate; an `alt` of a
   * single space means "nothing on the alternate".
   */
  const add = (main: string, alt?: string): void => {
    if (alt === undefined) {
      primary += main;
      secondary += main;
      return;
    }
    primary += main;
    if (alt !== ' ') secondary += alt;
  };

  let current = 0;

  // Skip these when at start of word.
  if (stringAt(0, 2, 'GN', 'KN', 'PN', 'WR', 'PS')) current += 1;

  // Initial 'X' is pronounced 'Z' e.g. 'Xavier'.
  if (getAt(0) === 'X') {
    add('S');
    current += 1;
  }

  while (primary.length < maxLength || secondary.length < maxLength) {
    if (current >= length) break;

    const ch = getAt(current);
    switch (ch) {
      case 'A':
      case 'E':
      case 'I':
      case 'O':
      case 'U':
      case 'Y':
        if (current === 0) add('A'); // all init vowels now map to 'A'
        current += 1;
        break;

      case 'B':
        // "-mb", e.g "dumb", already skipped over...
        add('P');
        current += getAt(current + 1) === 'B' ? 2 : 1;
        break;

      case 'Ç':
        add('S');
        current += 1;
        break;

      case 'C':
        // Various germanic.
        if (
          current > 1 &&
          !isVowel(current - 2) &&
          stringAt(current - 1, 3, 'ACH') &&
          getAt(current + 2) !== 'I' &&
          (getAt(current + 2) !== 'E' || stringAt(current - 2, 6, 'BACHER', 'MACHER'))
        ) {
          add('K');
          current += 2;
          break;
        }

        // Special case 'caesar'.
        if (current === 0 && stringAt(current, 6, 'CAESAR')) {
          add('S');
          current += 2;
          break;
        }

        // Italian 'chianti'.
        if (stringAt(current, 4, 'CHIA')) {
          add('K');
          current += 2;
          break;
        }

        if (stringAt(current, 2, 'CH')) {
          // Find 'michael'.
          if (current > 0 && stringAt(current, 4, 'CHAE')) {
            add('K', 'X');
            current += 2;
            break;
          }

          // Greek roots e.g. 'chemistry', 'chorus'.
          if (
            current === 0 &&
            (stringAt(current + 1, 5, 'HARAC', 'HARIS') ||
              stringAt(current + 1, 3, 'HOR', 'HYM', 'HIA', 'HEM')) &&
            !stringAt(0, 5, 'CHORE')
          ) {
            add('K');
            current += 2;
            break;
          }

          // Germanic, greek, or otherwise 'ch' for 'kh' sound.
          if (
            stringAt(0, 4, 'VAN ', 'VON ') ||
            stringAt(0, 3, 'SCH') ||
            // 'architect but not 'arch', 'orchestra', 'orchid'
            stringAt(current - 2, 6, 'ORCHES', 'ARCHIT', 'ORCHID') ||
            stringAt(current + 2, 1, 'T', 'S') ||
            ((stringAt(current - 1, 1, 'A', 'O', 'U', 'E') || current === 0) &&
              // e.g., 'wachtler', 'wechsler', but not 'tichner'
              stringAt(current + 2, 1, 'L', 'R', 'N', 'M', 'B', 'H', 'F', 'V', 'W', ' '))
          ) {
            add('K');
          } else if (current > 0) {
            // e.g., "McHugh"
            if (stringAt(0, 2, 'MC')) add('K');
            else add('X', 'K');
          } else {
            add('X');
          }
          current += 2;
          break;
        }

        // e.g, 'czerny'
        if (stringAt(current, 2, 'CZ') && !stringAt(current - 2, 4, 'WICZ')) {
          add('S', 'X');
          current += 2;
          break;
        }

        // e.g., 'focaccia'
        if (stringAt(current + 1, 3, 'CIA')) {
          add('X');
          current += 3;
          break;
        }

        // Double 'C', but not if e.g. 'McClellan'.
        if (stringAt(current, 2, 'CC') && !(current === 1 && getAt(0) === 'M')) {
          // 'bellocchio' but not 'bacchus'
          if (stringAt(current + 2, 1, 'I', 'E', 'H') && !stringAt(current + 2, 2, 'HU')) {
            // 'accident', 'accede' 'succeed'
            if ((current === 1 && getAt(current - 1) === 'A') || stringAt(current - 1, 5, 'UCCEE', 'UCCES')) {
              add('KS');
            } else {
              // 'bacci', 'bertucci', other italian
              add('X');
            }
            current += 3;
            break;
          }
          // Pierce's rule.
          add('K');
          current += 2;
          break;
        }

        if (stringAt(current, 2, 'CK', 'CG', 'CQ')) {
          add('K');
          current += 2;
          break;
        }

        if (stringAt(current, 2, 'CI', 'CE', 'CY')) {
          // Italian vs. english.
          if (stringAt(current, 3, 'CIO', 'CIE', 'CIA')) add('S', 'X');
          else add('S');
          current += 2;
          break;
        }

        add('K');

        // Name sent in 'mac caffrey', 'mac gregor'.
        if (stringAt(current + 1, 2, ' C', ' Q', ' G')) current += 3;
        else if (stringAt(current + 1, 1, 'C', 'K', 'Q') && !stringAt(current + 1, 2, 'CE', 'CI')) current += 2;
        else current += 1;
        break;

      case 'D':
        if (stringAt(current, 2, 'DG')) {
          if (stringAt(current + 2, 1, 'I', 'E', 'Y')) {
            // e.g. 'edge'
            add('J');
            current += 3;
          } else {
            // e.g. 'edgar'
            add('TK');
            current += 2;
          }
          break;
        }
        if (stringAt(current, 2, 'DT', 'DD')) {
          add('T');
          current += 2;
          break;
        }
        add('T');
        current += 1;
        break;

      case 'F':
        current += getAt(current + 1) === 'F' ? 2 : 1;
        add('F');
        break;

      case 'G':
        if (getAt(current + 1) === 'H') {
          if (current > 0 && !isVowel(current - 1)) {
            add('K');
            current += 2;
            break;
          }

          // 'ghislane', 'ghiradelli'
          if (current === 0) {
            if (getAt(current + 2) === 'I') add('J');
            else add('K');
            current += 2;
            break;
          }

          // Parker's rule (with some further refinements) - e.g., 'hugh'
          if (
            (current > 1 && stringAt(current - 2, 1, 'B', 'H', 'D')) ||
            // e.g., 'bough'
            (current > 2 && stringAt(current - 3, 1, 'B', 'H', 'D')) ||
            // e.g., 'broughton'
            (current > 3 && stringAt(current - 4, 1, 'B', 'H'))
          ) {
            current += 2;
            break;
          }

          // e.g., 'laugh', 'McLaughlin', 'cough', 'gough', 'rough', 'tough'
          if (current > 2 && getAt(current - 1) === 'U' && stringAt(current - 3, 1, 'C', 'G', 'L', 'R', 'T')) {
            add('F');
          } else if (current > 0 && getAt(current - 1) !== 'I') {
            add('K');
          }
          current += 2;
          break;
        }

        if (getAt(current + 1) === 'N') {
          if (current === 1 && isVowel(0) && !slavoGermanic) {
            add('KN', 'N');
          } else if (!stringAt(current + 2, 2, 'EY') && getAt(current + 1) !== 'Y' && !slavoGermanic) {
            // not e.g. 'cagney'
            add('N', 'KN');
          } else {
            add('KN');
          }
          current += 2;
          break;
        }

        // 'tagliaro'
        if (stringAt(current + 1, 2, 'LI') && !slavoGermanic) {
          add('KL', 'L');
          current += 2;
          break;
        }

        // -ges-, -gep-, -gel-, -gie- at beginning
        if (
          current === 0 &&
          (getAt(current + 1) === 'Y' ||
            stringAt(current + 1, 2, 'ES', 'EP', 'EB', 'EL', 'EY', 'IB', 'IL', 'IN', 'IE', 'EI', 'ER'))
        ) {
          add('K', 'J');
          current += 2;
          break;
        }

        // -ger-, -gy-
        if (
          (stringAt(current + 1, 2, 'ER') || getAt(current + 1) === 'Y') &&
          !stringAt(0, 6, 'DANGER', 'RANGER', 'MANGER') &&
          !stringAt(current - 1, 1, 'E', 'I') &&
          !stringAt(current - 1, 3, 'RGY', 'OGY')
        ) {
          add('K', 'J');
          current += 2;
          break;
        }

        // Italian e.g, 'biaggi'
        if (stringAt(current + 1, 1, 'E', 'I', 'Y') || stringAt(current - 1, 4, 'AGGI', 'OGGI')) {
          // Obvious germanic.
          if (stringAt(0, 4, 'VAN ', 'VON ') || stringAt(0, 3, 'SCH') || stringAt(current + 1, 2, 'ET')) {
            add('K');
          } else if (stringAt(current + 1, 4, 'IER ')) {
            // Always soft if french ending.
            add('J');
          } else {
            add('J', 'K');
          }
          current += 2;
          break;
        }

        current += getAt(current + 1) === 'G' ? 2 : 1;
        add('K');
        break;

      case 'H':
        // Only keep if first & before vowel or btw. 2 vowels.
        if ((current === 0 || isVowel(current - 1)) && isVowel(current + 1)) {
          add('H');
          current += 2;
        } else {
          // Also takes care of 'HH'.
          current += 1;
        }
        break;

      case 'J':
        // Obvious spanish, 'jose', 'san jacinto'.
        if (stringAt(current, 4, 'JOSE') || stringAt(0, 4, 'SAN ')) {
          if ((current === 0 && getAt(current + 4) === ' ') || stringAt(0, 4, 'SAN ')) add('H');
          else add('J', 'H');
          current += 1;
          break;
        }

        if (current === 0 && !stringAt(current, 4, 'JOSE')) {
          add('J', 'A'); // Yankelovich/Jankelowicz
        } else if (isVowel(current - 1) && !slavoGermanic && (getAt(current + 1) === 'A' || getAt(current + 1) === 'O')) {
          // Spanish pron. of e.g. 'bajador'.
          add('J', 'H');
        } else if (current === last) {
          add('J', ' ');
        } else if (
          !stringAt(current + 1, 1, 'L', 'T', 'K', 'S', 'N', 'M', 'B', 'Z') &&
          !stringAt(current - 1, 1, 'S', 'K', 'L')
        ) {
          add('J');
        }

        // It could happen!
        current += getAt(current + 1) === 'J' ? 2 : 1;
        break;

      case 'K':
        current += getAt(current + 1) === 'K' ? 2 : 1;
        add('K');
        break;

      case 'L':
        if (getAt(current + 1) === 'L') {
          // Spanish e.g. 'cabrillo', 'gallegos'.
          if (
            (current === length - 3 && stringAt(current - 1, 4, 'ILLO', 'ILLA', 'ALLE')) ||
            ((stringAt(last - 1, 2, 'AS', 'OS') || stringAt(last, 1, 'A', 'O')) && stringAt(current - 1, 4, 'ALLE'))
          ) {
            add('L', ' ');
            current += 2;
            break;
          }
          current += 2;
        } else {
          current += 1;
        }
        add('L');
        break;

      case 'M':
        if (
          (stringAt(current - 1, 3, 'UMB') && (current + 1 === last || stringAt(current + 2, 2, 'ER'))) ||
          // 'dumb', 'thumb'
          getAt(current + 1) === 'M'
        ) {
          current += 2;
        } else {
          current += 1;
        }
        add('M');
        break;

      case 'N':
        current += getAt(current + 1) === 'N' ? 2 : 1;
        add('N');
        break;

      case 'Ñ':
        current += 1;
        add('N');
        break;

      case 'P':
        if (getAt(current + 1) === 'H') {
          add('F');
          current += 2;
          break;
        }
        // Also account for "campbell", "raspberry".
        current += stringAt(current + 1, 1, 'P', 'B') ? 2 : 1;
        add('P');
        break;

      case 'Q':
        current += getAt(current + 1) === 'Q' ? 2 : 1;
        add('K');
        break;

      case 'R':
        // French e.g. 'rogier', but exclude 'hochmeier'.
        if (current === last && !slavoGermanic && stringAt(current - 2, 2, 'IE') && !stringAt(current - 4, 2, 'ME', 'MA')) {
          add('', 'R');
        } else {
          add('R');
        }
        current += getAt(current + 1) === 'R' ? 2 : 1;
        break;

      case 'S':
        // Special cases 'island', 'isle', 'carlisle', 'carlysle'.
        if (stringAt(current - 1, 3, 'ISL', 'YSL')) {
          current += 1;
          break;
        }

        // Special case 'sugar-'.
        if (current === 0 && stringAt(current, 5, 'SUGAR')) {
          add('X', 'S');
          current += 1;
          break;
        }

        if (stringAt(current, 2, 'SH')) {
          // Germanic.
          if (stringAt(current + 1, 4, 'HEIM', 'HOEK', 'HOLM', 'HOLZ')) add('S');
          else add('X');
          current += 2;
          break;
        }

        // Italian & armenian.
        if (stringAt(current, 3, 'SIO', 'SIA') || stringAt(current, 4, 'SIAN')) {
          if (!slavoGermanic) add('S', 'X');
          else add('S');
          current += 3;
          break;
        }

        // German & anglicisations, e.g. 'smith' match 'schmidt', 'snider'
        // match 'schneider'; also, -sz- in slavic language although in
        // hungarian it is pronounced 's'.
        if ((current === 0 && stringAt(current + 1, 1, 'M', 'N', 'L', 'W')) || stringAt(current + 1, 1, 'Z')) {
          add('S', 'X');
          current += stringAt(current + 1, 1, 'Z') ? 2 : 1;
          break;
        }

        if (stringAt(current, 2, 'SC')) {
          // Schlesinger's rule.
          if (getAt(current + 2) === 'H') {
            // Dutch origin, e.g. 'school', 'schooner'.
            if (stringAt(current + 3, 2, 'OO', 'ER', 'EN', 'UY', 'ED', 'EM')) {
              // 'schermerhorn', 'schenker'
              if (stringAt(current + 3, 2, 'ER', 'EN')) add('X', 'SK');
              else add('SK');
              current += 3;
              break;
            }
            if (current === 0 && !isVowel(3) && getAt(3) !== 'W') add('X', 'S');
            else add('X');
            current += 3;
            break;
          }

          if (stringAt(current + 2, 1, 'I', 'E', 'Y')) {
            add('S');
            current += 3;
            break;
          }

          add('SK');
          current += 3;
          break;
        }

        // French e.g. 'resnais', 'artois'.
        if (current === last && stringAt(current - 2, 2, 'AI', 'OI')) add('', 'S');
        else add('S');

        current += stringAt(current + 1, 1, 'S', 'Z') ? 2 : 1;
        break;

      case 'T':
        if (stringAt(current, 4, 'TION')) {
          add('X');
          current += 3;
          break;
        }

        if (stringAt(current, 3, 'TIA', 'TCH')) {
          add('X');
          current += 3;
          break;
        }

        if (stringAt(current, 2, 'TH') || stringAt(current, 3, 'TTH')) {
          // Special case 'thomas', 'thames' or germanic.
          if (stringAt(current + 2, 2, 'OM', 'AM') || stringAt(0, 4, 'VAN ', 'VON ') || stringAt(0, 3, 'SCH')) {
            add('T');
          } else {
            add('0', 'T');
          }
          current += 2;
          break;
        }

        current += stringAt(current + 1, 1, 'T', 'D') ? 2 : 1;
        add('T');
        break;

      case 'V':
        current += getAt(current + 1) === 'V' ? 2 : 1;
        add('F');
        break;

      case 'W':
        // Can also be in middle of word.
        if (stringAt(current, 2, 'WR')) {
          add('R');
          current += 2;
          break;
        }

        if (current === 0 && (isVowel(current + 1) || stringAt(current, 2, 'WH'))) {
          // Wasserman should match Vasserman.
          if (isVowel(current + 1)) add('A', 'F');
          // Need Uomo to match Womo.
          else add('A');
        }

        // Arnow should match Arnoff.
        if (
          (current === last && isVowel(current - 1)) ||
          stringAt(current - 1, 5, 'EWSKI', 'EWSKY', 'OWSKI', 'OWSKY') ||
          stringAt(0, 3, 'SCH')
        ) {
          add('', 'F');
          current += 1;
          break;
        }

        // Polish e.g. 'filipowicz'.
        if (stringAt(current, 4, 'WICZ', 'WITZ')) {
          add('TS', 'FX');
          current += 4;
          break;
        }

        // Else skip it.
        current += 1;
        break;

      case 'X':
        // French e.g. breaux.
        if (!(current === last && (stringAt(current - 3, 3, 'IAU', 'EAU') || stringAt(current - 2, 2, 'AU', 'OU')))) {
          add('KS');
        }
        current += stringAt(current + 1, 1, 'C', 'X') ? 2 : 1;
        break;

      case 'Z':
        // Chinese pinyin e.g. 'zhao'.
        if (getAt(current + 1) === 'H') {
          add('J');
          current += 2;
          break;
        }
        if (stringAt(current + 1, 2, 'ZO', 'ZI', 'ZA') || (slavoGermanic && current > 0 && getAt(current - 1) !== 'T')) {
          add('S', 'TS');
        } else {
          add('S');
        }
        current += getAt(current + 1) === 'Z' ? 2 : 1;
        break;

      default:
        current += 1;
    }
  }

  return [primary.slice(0, maxLength), secondary.slice(0, maxLength)];
}

// -----------------------------------------------------------------------------
// Normalization
// -----------------------------------------------------------------------------

const COMBINING_MARKS = /\p{M}+/gu;
const NON_LETTERS = /[^\p{L}]+/gu;

/**
 * Fold diacritics (NFD, then strip every combining mark), lower-case, and drop
 * everything that is not a letter. `"José"`, `"jose"` and `"Jo-sé!"` all
 * become `"jose"`; `"María José"` becomes `"mariajose"`.
 *
 * `ß` has no decomposition and is kept as-is; that is a deliberate limit of a
 * fold that must never change a name's letter count by more than it has to.
 */
export function normalizeName(input: string): string {
  return input.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase().replace(NON_LETTERS, '');
}

/**
 * {@link normalizeName} tuned for phonetic encoding: a `ç` (which NFD would
 * fold to a hard `c`) is spelled with the `s` it sounds like first.
 */
export function normalizeForPhonetic(input: string): string {
  return normalizeName(input.replace(/[çÇ]/g, 's'));
}

/**
 * Double Metaphone keys of a normalized name, de-duplicated: one key when the
 * primary and alternate agree, two when they differ, none for an input with no
 * letters (or whose letters encode to nothing).
 */
export function phoneticKeys(input: string, maxLength = 4): string[] {
  const norm = normalizeForPhonetic(input);
  if (norm.length === 0) return [];
  const [p, a] = doubleMetaphone(norm, maxLength);
  const keys: string[] = [];
  if (p) keys.push(p);
  if (a && a !== p) keys.push(a);
  return keys;
}

// -----------------------------------------------------------------------------
// String similarity
// -----------------------------------------------------------------------------

/**
 * Jaro-Winkler similarity in `[0, 1]` (1 = identical), with the standard
 * prefix scale `p = 0.1` and a common-prefix cap of 4. Compares UTF-16 code
 * units as given — normalize first when case or accents must not count.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;

  // Scratch buffers reused across calls: this runs hundreds of thousands of
  // times per transcript, and two fresh arrays per call dominated it. Reuse is
  // safe because the function is synchronous and never re-entered.
  // `bStamp[j] === stamp` means "b[j] is matched in THIS call", so the buffer
  // never needs clearing.
  while (jwBStamp.length < lb) jwBStamp.push(0);
  while (jwAChars.length < la) jwAChars.push(0);
  jwStamp += 1;
  if (jwStamp >= 0x3fffffff) {
    jwBStamp.fill(0);
    jwStamp = 1;
  }
  const stamp = jwStamp;
  const bStamp = jwBStamp;
  const aChars = jwAChars;

  // No `Math.*` in this function or in `levenshtein`: they are the hot loop of
  // candidate retrieval, and under Jest's `vm` sandbox every `Math` call
  // measured ~100x slower than native, which alone blew the time budget.
  const longer = la > lb ? la : lb;
  const half = (longer >> 1) - 1;
  const window = half > 0 ? half : 0;
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const ca = a.charCodeAt(i);
    const lo = i - window > 0 ? i - window : 0;
    const hi = i + window < lb - 1 ? i + window : lb - 1;
    for (let j = lo; j <= hi; j++) {
      if (bStamp[j] === stamp || ca !== b.charCodeAt(j)) continue;
      bStamp[j] = stamp;
      aChars[matches++] = ca; // a's matched characters, in a's order
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let j = 0; j < lb && k < matches; j++) {
    if (bStamp[j] !== stamp) continue;
    if (b.charCodeAt(j) !== aChars[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / la + m / lb + (m - transpositions / 2) / m) / 3;

  let prefix = 0;
  const shorter = la < lb ? la : lb;
  const maxPrefix = shorter < 4 ? shorter : 4;
  while (prefix < maxPrefix && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;

  return jaro + prefix * 0.1 * (1 - jaro);
}

const jwBStamp: number[] = new Array<number>(64).fill(0);
const jwAChars: number[] = new Array<number>(64).fill(0);
let jwStamp = 0;

/**
 * Levenshtein edit distance (insert/delete/substitute, each cost 1).
 *
 * With `max`, the computation is bounded: it stops as soon as the distance is
 * known to exceed `max` and returns `max + 1`. That keeps the common "is this
 * within 1 edit" question O(n) instead of O(n·m) on unrelated strings.
 */
export function levenshtein(a: string, b: string, max?: number): number {
  if (a === b) return 0;
  let s = a;
  let t = b;
  if (s.length > t.length) {
    const tmp = s;
    s = t;
    t = tmp;
  }
  const ls = s.length;
  const lt = t.length;
  const bound = max === undefined ? Infinity : max > 0 ? max : 0;
  if (lt - ls > bound) return bound + 1;
  if (ls === 0) return lt;

  let prev = new Array<number>(ls + 1);
  let curr = new Array<number>(ls + 1);
  for (let i = 0; i <= ls; i++) prev[i] = i;

  for (let j = 1; j <= lt; j++) {
    curr[0] = j;
    let rowMin = curr[0];
    const tc = t.charCodeAt(j - 1);
    for (let i = 1; i <= ls; i++) {
      const cost = s.charCodeAt(i - 1) === tc ? 0 : 1;
      const del = prev[i]! + 1;
      const ins = curr[i - 1]! + 1;
      const sub = prev[i - 1]! + cost;
      const v = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
      curr[i] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > bound) return bound + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const d = prev[ls]!;
  return d > bound ? bound + 1 : d;
}
