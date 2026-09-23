// =============================================================================
// Name-correction candidate retrieval (issue #328, epic #326)
// =============================================================================
//
// Stage 1 only proposes; an LLM verifies later. So these tests pin two things:
// the mis-hearings a user would obviously expect caught ARE caught, with
// offsets that replace exactly the misheard span — and correctly spelled names,
// their possessives, and ordinary prose are NOT, because every false positive
// here is a token spent in stage 2.
// =============================================================================

import {
  buildTargets,
  CandidateSegment,
  DEFAULT_MIN_SCORE,
  findCandidates,
  NameCandidate,
  tokenize,
} from './candidates';

let nextId = 0;
function seg(text: string, words?: CandidateSegment['words']): CandidateSegment {
  nextId += 1;
  return { id: `seg-${nextId}`, rev: 3, speakerId: 'spk-a', startMs: nextId * 1000, text, words };
}

function run(names: string[], texts: string[]): NameCandidate[] {
  return findCandidates(
    texts.map((t) => seg(t)),
    buildTargets(names),
  ).candidates;
}

function originals(names: string[], text: string): string[] {
  return run(names, [text]).map((c) => c.original);
}

describe('tokenize', () => {
  it('reports UTF-16 offsets that exclude surrounding punctuation', () => {
    const text = '"Oh, scar!" — O\'Brien-Smith’s café… 2024';
    const toks = tokenize(text);
    expect(toks.map((t) => t.text)).toEqual(['Oh', 'scar', "O'Brien-Smith’s", 'café', '2024']);
    for (const t of toks) expect(text.slice(t.start, t.end)).toBe(t.text);
  });

  it('keeps combining marks inside the token', () => {
    const decomposed = 'José llegó';
    expect(tokenize(decomposed).map((t) => t.text)).toEqual(['José', 'llegó']);
  });
});

describe('buildTargets', () => {
  it('adds each full name and the ≥3-char tokens of multi-word names', () => {
    expect(buildTargets(['Oscar Marín']).map((t) => t.text)).toEqual(['Oscar Marín', 'Oscar', 'Marín']);
    expect(buildTargets(['Jo Ann Li']).map((t) => t.text)).toEqual(['Jo Ann Li', 'Ann']);
  });

  it('drops generic speaker labels', () => {
    expect(buildTargets(['Speaker A', 'speaker 2', 'SpeakerB', 'Unknown', 'Unknown speaker', 'Ana'])).toHaveLength(1);
  });

  it('dedupes case- and diacritic-insensitively, first spelling wins', () => {
    const t = buildTargets(['Óscar', 'oscar', 'OSCAR', 'Oscar Marín', 'Marin']);
    expect(t.map((x) => x.text)).toEqual(['Óscar', 'Oscar Marín', 'Marín']);
  });

  it('caps the list at 200', () => {
    const names = Array.from({ length: 300 }, (_, i) => `Name${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    expect(buildTargets(names)).toHaveLength(200);
  });

  it('ignores blank input', () => {
    expect(buildTargets(['', '   ', '!!!'])).toEqual([]);
  });
});

describe('findCandidates — Oscar', () => {
  it('finds a one-token mis-hearing with exact offsets', () => {
    const text = 'I talked to Skar yesterday.';
    const [c, ...rest] = run(['Oscar'], [text]);
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ original: 'Skar', target: 'Oscar', segmentRev: 3 });
    expect(text.slice(c!.start, c!.end)).toBe('Skar');
    expect(c!.score).toBeGreaterThanOrEqual(DEFAULT_MIN_SCORE);
  });

  it('replaces a two-token mis-hearing as one span', () => {
    const text = 'Well, Oh scar, are you there?';
    const cands = run(['Oscar'], [text]);
    expect(cands).toHaveLength(1);
    const c = cands[0]!;
    expect(c.original).toBe('Oh scar');
    expect([c.start, c.end]).toEqual([6, 13]);
    expect(text.slice(c.start, c.end)).toBe('Oh scar');
    expect(c.signals.tokenCount).toBe(2);
    expect(c.signals.phonetic).toBe('exact');
  });

  it('never proposes the correct name, its possessive, plural, or accented spelling', () => {
    expect(originals(['Oscar'], 'Oscar is here.')).toEqual([]);
    expect(originals(['Oscar'], "That is Oscar's car.")).toEqual([]);
    expect(originals(['Oscar'], 'That is Oscar’s car.')).toEqual([]);
    expect(originals(['Oscar'], 'Both Oscars agreed.')).toEqual([]);
    expect(originals(['Oscar'], 'Óscar llegó tarde.')).toEqual([]);
    expect(originals(['Óscar'], 'OSCAR llegó tarde.')).toEqual([]);
  });

  it('never proposes a correctly spelled OTHER name', () => {
    // "Oscar" and "Osca" are close, but "Osca" is a name the user gave us.
    expect(originals(['Oscar', 'Osca'], 'Osca and Oscar met.')).toEqual([]);
  });

  it('does not let a window swallow a correct name next to a misspelling', () => {
    expect(originals(['Oscar Marín'], 'Oscar Marine said so.')).toEqual(['Marine']);
  });

  it('yields nothing for ordinary English and Spanish prose', () => {
    const paragraph =
      'Good morning everyone, thanks for joining the weekly planning meeting. Before we start, let me share a quick ' +
      'update on the budget. We spent a little more than expected on travel last month, mostly because the team flew ' +
      'to the conference in Madrid, but the numbers are still within the plan we agreed on in January. The new office ' +
      'is almost ready; the painters finish on Friday and the furniture arrives next week. If anybody needs a parking ' +
      'permit, please send me an email today. Now, about the product launch: marketing wants to move the date forward ' +
      "by two weeks, and engineering thinks that is risky. I would like each of you to think about it and bring a clear " +
      "opinion to Thursday's review. Bueno, ahora en español para los compañeros de la oficina de Bogotá. La reunión " +
      'del jueves empieza a las nueve de la mañana. Necesitamos revisar el presupuesto, hablar con los clientes nuevos ' +
      'y decidir quién va a viajar en noviembre. Por favor, lean el documento antes de la llamada y traigan sus ' +
      'preguntas. Muchas gracias a todos por el trabajo de este trimestre, fue muy bueno. Okay, that is everything ' +
      'from my side, let us take a short break and continue with the engineering demo in ten minutes.';
    const sentences = paragraph.split(/(?<=[.:;])\s+/);
    expect(paragraph.split(/\s+/).length).toBeGreaterThanOrEqual(200);
    const r = findCandidates(sentences.map((s) => seg(s)), buildTargets(['Oscar']));
    expect(r.candidates).toEqual([]);
    expect(r.scannedSegments).toBe(sentences.length);
    expect(r.scannedTokens).toBeGreaterThanOrEqual(200);
  });
});

describe('findCandidates — other names', () => {
  it('Siobhan: Shivon and Shevaun', () => {
    expect(originals(['Siobhan'], 'Shivon said hi.')).toEqual(['Shivon']);
    expect(originals(['Siobhan'], 'Then Shevaun left.')).toEqual(['Shevaun']);
    expect(originals(['Siobhan'], 'Siobhan left.')).toEqual([]);
  });

  it('Nguyen: Nwin and Nguyin, but not the bare "Win" or "nine"', () => {
    expect(originals(['Nguyen'], 'Nwin came early.')).toEqual(['Nwin']);
    expect(originals(['Nguyen'], 'Nguyin came early.')).toEqual(['Nguyin']);
    // "Win" shares no phonetic key with Nguyen and too few letters: missed by
    // design at this stage. "nine"/"none" would match only through the gu→w
    // respelling, which requires letter similarity too.
    expect(originals(['Nguyen'], 'Win came early.')).toEqual([]);
    expect(originals(['Nguyen'], 'nine none noon')).toEqual([]);
  });

  it('María José: accent-free spelling is exact, a mis-hearing is a candidate', () => {
    expect(originals(['María José'], 'Maria Jose is here.')).toEqual([]);
    const c = run(['María José'], ['Mari Hose is here.']);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ original: 'Mari Hose', target: 'María José', start: 0, end: 9 });
  });

  it('never crosses a segment boundary', () => {
    const cands = run(['Oscar'], ['We said oh', 'scar tissue heals']);
    expect(cands.every((c) => c.original !== 'oh scar')).toBe(true);
  });

  it('keeps at most one candidate per character, ordered by segment then offset', () => {
    const cands = run(['Oscar'], ['Skar and Oh scar', 'Skar']);
    expect(cands.map((c) => [c.segmentId, c.original])).toEqual([
      [cands[0]!.segmentId, 'Skar'],
      [cands[0]!.segmentId, 'Oh scar'],
      [cands[2]!.segmentId, 'Skar'],
    ]);
    expect(cands[0]!.segmentId).not.toBe(cands[2]!.segmentId);
    for (let i = 1; i < 2; i++) expect(cands[i]!.start).toBeGreaterThanOrEqual(cands[i - 1]!.end);
  });

  it('penalises a lone function word', () => {
    // "Ana" vs "an": letter-similar, but "an" is a stopword.
    expect(originals(['Ana'], 'It was an idea.')).toEqual([]);
    const withPenaltyIgnored = findCandidates([seg('It was an idea.')], buildTargets(['Ana']), { minScore: 0 });
    expect(withPenaltyIgnored.candidates.map((c) => c.signals.stopword)).toEqual([true]);
  });

  it('is deterministic', () => {
    const texts = ['Skar and Shivon', 'Oh scar met Nwin', 'Mari Hose'];
    const names = ['Oscar', 'Siobhan', 'Nguyen', 'María José'];
    expect(run(names, texts).map(({ segmentId: _s, ...c }) => c)).toEqual(
      run(names, texts).map(({ segmentId: _s, ...c }) => c),
    );
  });
});

describe('findCandidates — word confidence', () => {
  it('raises the score when the aligned words have low confidence', () => {
    const text = 'I spoke with Skar, today.';
    const words = (c: number | null) => [
      { t: 'I', c: 0.99 },
      { t: 'spoke', c: 0.98 },
      { t: 'with', c: 0.97 },
      { t: 'Skar,', c },
      { t: 'today.', c: 0.99 },
    ];
    const targets = buildTargets(['Oscar']);
    const plain = findCandidates([seg(text)], targets).candidates[0]!;
    const confident = findCandidates([seg(text, words(0.95))], targets).candidates[0]!;
    const doubtful = findCandidates([seg(text, words(0.2))], targets).candidates[0]!;
    const unknown = findCandidates([seg(text, words(null))], targets).candidates[0]!;

    expect(confident.score).toBe(plain.score);
    expect(unknown.score).toBe(plain.score);
    expect(doubtful.score).toBeGreaterThan(plain.score);
    expect(doubtful.signals).toMatchObject({ lowConfidence: true, minConfidence: 0.2 });
    expect(confident.signals).toMatchObject({ lowConfidence: false, minConfidence: 0.95 });
    expect(unknown.signals.minConfidence).toBeNull();
  });

  it('survives words that do not line up with the text', () => {
    const r = findCandidates(
      [seg('I spoke with Skar today', [{ t: 'completely', c: 0.1 }, { t: 'different', c: 0.1 }])],
      buildTargets(['Oscar']),
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.signals.minConfidence).toBeNull();
  });
});

describe('findCandidates — cap', () => {
  it('keeps the highest scores and reports truncation', () => {
    const texts = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 'Oh scar' : 'Skar'));
    const targets = buildTargets(['Oscar']);
    const full = findCandidates(texts.map((t) => seg(t)), targets);
    expect(full.truncated).toBe(false);
    expect(full.candidates).toHaveLength(10);

    const capped = findCandidates(texts.map((t) => seg(t)), targets, { maxCandidates: 5 });
    expect(capped.truncated).toBe(true);
    expect(capped.candidates.map((c) => c.original)).toEqual(Array(5).fill('Oh scar'));
  });
});

describe('findCandidates — performance', () => {
  // mulberry32: a fixed-seed PRNG so the corpus is identical on every run.
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const VOCAB = (
    'the and a to of in is it you that we they so this was for on are with as have be at one ' +
    'meeting project budget review team plan week month client report number launch office travel ' +
    'design product release schedule question answer problem issue change update version feature ' +
    'think know want need make take look come work call send start finish move keep bring share ' +
    'good great small large early late quick clear simple ready important different possible likely ' +
    'yesterday today tomorrow morning afternoon evening monday tuesday friday later again already ' +
    'reunión proyecto cliente semana mañana trabajo documento pregunta problema equipo oficina ' +
    'presupuesto llamada correo viaje noviembre jueves gracias bueno ahora después también'
  ).split(/\s+/);

  const NAMES = [
    'Oscar', 'Siobhan', 'Nguyen', 'María José', 'Kathryn', 'Joaquín', 'Xiomara', 'Priya', 'Rajesh',
    'Wojciech', 'Saoirse', 'Guillermo', 'Deepak', 'Chandra', 'Ximena', 'Ignacio', 'Bartholomew',
    'Penelope', 'Thaddeus', 'Ingrid',
  ];

  // [misspelling, expected target]
  const INJECTED: Array<[string, string]> = [
    ['Skar', 'Oscar'],
    ['Oh scar', 'Oscar'],
    ['Shivon', 'Siobhan'],
    ['Nguyin', 'Nguyen'],
    ['Mari Hose', 'María José'],
    ['Katrin', 'Kathryn'],
    ['Priyah', 'Priya'],
    ['Rajes', 'Rajesh'],
    ['Gillermo', 'Guillermo'],
    ['Dipak', 'Deepak'],
    ['Shandra', 'Chandra'],
    ['Ignasio', 'Ignacio'],
    ['Penelopy', 'Penelope'],
    ['Thadeus', 'Thaddeus'],
    ['Ingred', 'Ingrid'],
  ];

  it('scans a two-hour transcript (3,000 segments × 10 words) in well under a second and a half', () => {
    const rand = rng(328);
    const segments: CandidateSegment[] = [];
    const expected = new Map<string, { original: string; target: string }>();
    for (let s = 0; s < 3000; s++) {
      const words = Array.from({ length: 10 }, () => VOCAB[Math.floor(rand() * VOCAB.length)]!);
      const id = `perf-${s}`;
      if (s % 97 === 0) {
        const [miss, target] = INJECTED[(s / 97) % INJECTED.length]!;
        words[5] = miss;
        expected.set(id, { original: miss, target });
      }
      // A correctly spelled name now and then, which must never be proposed.
      if (s % 89 === 0) words[1] = NAMES[s % NAMES.length]!;
      segments.push({ id, rev: 1, speakerId: 'spk', startMs: s * 2400, text: words.join(' ') + '.' });
    }
    const targets = buildTargets(NAMES);

    const t0 = performance.now();
    const r = findCandidates(segments, targets);
    const elapsed = performance.now() - t0;

    expect(r.scannedSegments).toBe(3000);
    expect(r.scannedTokens).toBeGreaterThanOrEqual(30000);
    expect(elapsed).toBeLessThan(1500);
    expect(r.truncated).toBe(false);

    for (const [id, want] of expected) {
      const hit = r.candidates.find((c) => c.segmentId === id && c.original === want.original);
      expect({ id, hit: hit && { original: hit.original, target: hit.target } }).toEqual({ id, hit: want });
    }
    const exactNames = new Set(NAMES.map((n) => n.toLowerCase()));
    expect(r.candidates.filter((c) => exactNames.has(c.original.toLowerCase()))).toEqual([]);
  });
});
