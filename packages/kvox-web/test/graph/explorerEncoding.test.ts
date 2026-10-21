import { describe, expect, it } from 'vitest';

import {
  CATEGORICAL_PALETTE,
  MIN_GRAPHICAL_CONTRAST,
  NODE_SIZE_MAX,
  NODE_SIZE_MIN,
  STANCES,
  STANCE_COLORS,
  VALIDATION_BACKGROUNDS,
  contrastRatio,
  edgeAppearance,
  edgeLabel,
  edgeWidth,
  encodingFor,
  iconUrlFor,
  nodeSize,
  normalizeTypeKey,
  ontologyNodeTypes,
  parallelCurvatures,
  parseHex,
  readableOn,
  ringFor,
  stanceOf,
  type ExplorerMode,
} from '../../src/graph/ui/components/explorer/explorerEncoding.js';
import { PICTOGRAMS, pictogramDataUri } from '../../src/graph/ui/components/explorer/icons/pictograms.js';
import type { GraphOntology } from '../../src/graph/headless/clients/graph.js';
import { mockGraphOntology } from './graphData.js';

/**
 * The explorer's visual language (#667): the palette is fixed and validated, so
 * these are the checks that keep it honest. Contrast is WCAG 1.4.11 (3:1 for a
 * graphical object); distinctness is measured under SIMULATED DEUTERANOPIA
 * (Machado, Oliveira and Fernandes 2009, severity 1) as CIE76 colour difference.
 */

const MODES: ExplorerMode[] = ['light', 'dark'];

// --- colour science for the checks (kept here: the model needs none of it) -----

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const unlin = (c: number) => {
  const v = Math.min(1, Math.max(0, c));
  return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
};
const DEUTERANOPIA = [
  [0.367322, 0.860646, -0.227968],
  [0.280085, 0.672501, 0.047413],
  [-0.01182, 0.04294, 0.968881],
];
function simulateDeuteranopia(hex: string): [number, number, number] {
  const rgb = parseHex(hex)!.map(lin);
  const out = DEUTERANOPIA.map((row) => unlin(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]));
  return [out[0], out[1], out[2]];
}
function lab(rgb: readonly number[]): [number, number, number] {
  const [r, g, b] = rgb.map(lin);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function deltaE(a: readonly number[], b: readonly number[]): number {
  const [la, lb] = [lab(a), lab(b)];
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}
function chroma(hex: string): number {
  const [, a, b] = lab(parseHex(hex)!);
  return Math.hypot(a, b);
}

/** The shipped ontology with every domain on, plus the types #662 to #664 will add. */
function ontologyWithPlannedTypes(): GraphOntology {
  const base = mockGraphOntology(['core', 'work', 'personal']);
  const template = base.entityTypes.find((t) => t.key === 'Project')!;
  const planned = ['Topic', 'Product', 'Risk'].map((key) => ({
    ...template,
    key,
    label: key,
    pluralLabel: `${key}s`,
  }));
  return { ...base, entityTypes: [...base.entityTypes, ...planned] };
}

describe('the categorical palette', () => {
  it('has the same number of colours in both variants, and every colour is distinct', () => {
    expect(CATEGORICAL_PALETTE.light).toHaveLength(CATEGORICAL_PALETTE.dark.length);
    for (const mode of MODES) {
      expect(new Set(CATEGORICAL_PALETTE[mode]).size).toBe(CATEGORICAL_PALETTE[mode].length);
    }
  });

  it.each(MODES)('every %s colour has at least 3:1 contrast against every canvas background', (mode) => {
    for (const color of CATEGORICAL_PALETTE[mode]) {
      for (const background of VALIDATION_BACKGROUNDS[mode]) {
        expect(
          contrastRatio(color, background),
          `${color} on ${background}`,
        ).toBeGreaterThanOrEqual(MIN_GRAPHICAL_CONTRAST);
      }
    }
  });

  it.each(MODES)('every %s colour stays distinguishable from every other under simulated deuteranopia', (mode) => {
    const colors = CATEGORICAL_PALETTE[mode];
    let weakest = Infinity;
    for (let i = 0; i < colors.length; i += 1) {
      for (let j = i + 1; j < colors.length; j += 1) {
        const difference = deltaE(simulateDeuteranopia(colors[i]), simulateDeuteranopia(colors[j]));
        weakest = Math.min(weakest, difference);
        expect(difference, `${colors[i]} vs ${colors[j]}`).toBeGreaterThanOrEqual(12);
      }
    }
    expect(weakest).toBeGreaterThan(12);
  });

  it.each(MODES)('no %s colour is grey', (mode) => {
    for (const color of CATEGORICAL_PALETTE[mode]) expect(chroma(color), color).toBeGreaterThan(20);
  });

  it('the checks themselves can fail: two near colours are not distinguishable, white on white has no contrast', () => {
    expect(deltaE(simulateDeuteranopia('#d43575'), simulateDeuteranopia('#d43a70'))).toBeLessThan(12);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0);
  });
});

describe('encodingFor and the ontology', () => {
  it.each(MODES)(
    'every type of the ontology, planned ones included, has its own %s colour AND its own pictogram, none grey',
    (mode) => {
      const ontology = ontologyWithPlannedTypes();
      const keys = ontologyNodeTypes(ontology);
      // The fixture really holds what the issue lists.
      for (const expected of ['Person', 'Organization', 'Project', 'Meeting', 'Topic', 'Product', 'Risk', 'commitment', 'decision', 'claim']) {
        expect(keys, expected).toContain(expected);
      }

      const encodings = keys.map((key) => ({ key, encoding: encodingFor(key, mode) }));
      const colors = new Map<string, string>();
      const icons = new Map<string, string>();
      for (const { key, encoding } of encodings) {
        expect(encoding.known, `${key} has an explicit entry`).toBe(true);
        expect(encoding.icon, `${key} has its own pictogram`).not.toBe('generic');
        expect(chroma(encoding.color), `${key} is not grey`).toBeGreaterThan(20);
        expect(colors.get(encoding.color), `${key} duplicates the colour of ${colors.get(encoding.color)}`).toBeUndefined();
        expect(icons.get(encoding.icon), `${key} duplicates the pictogram of ${icons.get(encoding.icon)}`).toBeUndefined();
        colors.set(encoding.color, key);
        icons.set(encoding.icon, key);
      }
    },
  );

  it('maps the issue table: Person person, Organization building, Project flag, ... Milestone milestone', () => {
    const icon = (type: string) => encodingFor(type).icon;
    expect(icon('Person')).toBe('person');
    expect(icon('Organization')).toBe('building');
    expect(icon('Project')).toBe('flag');
    expect(icon('Meeting')).toBe('calendar');
    expect(icon('Topic')).toBe('tag');
    expect(icon('Product')).toBe('cube');
    expect(icon('commitment')).toBe('check-circle');
    expect(icon('decision')).toBe('gavel');
    expect(icon('Risk')).toBe('warning');
    expect(icon('claim')).toBe('quote');
    expect(icon('Interest')).toBe('star');
    expect(icon('Trip')).toBe('plane');
    expect(icon('Milestone')).toBe('milestone');
  });

  it('an entity type and an item kind of the same name are one encoding (Risk and risk)', () => {
    expect(encodingFor('Risk')).toEqual(encodingFor('risk'));
    expect(normalizeTypeKey('Person_Fact')).toBe('personfact');
  });

  it('a type the table does not know gets a deterministic fallback: a palette colour, the generic pictogram', () => {
    const first = encodingFor('Initiative', 'dark');
    const second = encodingFor('Initiative', 'dark');
    expect(first).toEqual(second);
    expect(first.known).toBe(false);
    expect(first.icon).toBe('generic');
    expect(CATEGORICAL_PALETTE.dark).toContain(first.color);
    expect(encodingFor('Initiative', 'light').slot).toBe(first.slot);
  });

  it('person facts never reach a slice, so the ontology list leaves them out', () => {
    const keys = ontologyNodeTypes(ontologyWithPlannedTypes());
    expect(keys.map(normalizeTypeKey)).not.toContain('personfact');
  });

  it('the glyph is readable on its fill in every variant', () => {
    for (const mode of MODES) {
      for (const color of CATEGORICAL_PALETTE[mode]) {
        expect(contrastRatio(readableOn(color), color), color).toBeGreaterThanOrEqual(MIN_GRAPHICAL_CONTRAST);
      }
    }
  });
});

describe('pictograms', () => {
  it('has a glyph for every name the table uses, each a non-empty path', () => {
    for (const name of ['person', 'building', 'flag', 'calendar', 'tag', 'cube', 'check-circle', 'gavel', 'warning', 'quote', 'star', 'plane', 'milestone', 'generic', 'plus'] as const) {
      expect(PICTOGRAMS[name].length, name).toBeGreaterThan(10);
    }
  });

  it('is a bundled data URL, never a remote asset, and base64 so sigma draws it as an image, not a fetched .svg', () => {
    for (const type of ['Person', 'Topic', 'Risk', 'Unknown']) {
      const url = iconUrlFor(type);
      expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
      expect(url).not.toMatch(/https?:/);
      // `@sigma/node-image` fetches a source whose path ends in ".svg"; a base64 body has no ".".
      expect(url.split(/[#?]/)[0].split('.').pop()?.toLowerCase()).not.toBe('svg');
      const svg = atob(url.slice('data:image/svg+xml;base64,'.length));
      expect(svg).toContain('<svg');
      expect(svg).toContain('<path');
      expect(svg).toMatch(/width="\d+"/);
    }
    expect(pictogramDataUri('person')).toBe(pictogramDataUri('person'));
  });
});

describe('nodeSize', () => {
  it('is the square root of mentionCount, falling back to degree', () => {
    expect(nodeSize({ degree: 0 })).toBe(NODE_SIZE_MIN);
    expect(nodeSize({ degree: 4 })).toBeCloseTo(NODE_SIZE_MIN + 1.6 * 2, 2);
    // mentionCount wins over degree when present.
    expect(nodeSize({ mentionCount: 9, degree: 100 })).toBeCloseTo(NODE_SIZE_MIN + 1.6 * 3, 2);
    expect(nodeSize({ mentionCount: null, degree: 4 })).toBe(nodeSize({ degree: 4 }));
  });

  it('is monotonic, clamped to the range, and a phone can lower the ceiling', () => {
    let previous = 0;
    for (const n of [0, 1, 2, 5, 10, 50, 100, 1000, 100000]) {
      const size = nodeSize({ degree: n });
      expect(size).toBeGreaterThanOrEqual(previous);
      expect(size).toBeLessThanOrEqual(NODE_SIZE_MAX);
      previous = size;
    }
    expect(nodeSize({ degree: 100000 })).toBe(NODE_SIZE_MAX);
    expect(nodeSize({ degree: 100000 }, 14)).toBe(14);
  });

  it('draws an item at four-fifths of an entity', () => {
    expect(nodeSize({ degree: 25, nodeKind: 'item' })).toBeCloseTo(nodeSize({ degree: 25, nodeKind: 'entity' }) * 0.8, 1);
  });
});

describe('rings', () => {
  it('a seed is thick, a selected node thin, a pinned node thin with a gap, a plain node none', () => {
    const seed = ringFor({ isSeed: true })!;
    const selected = ringFor({ selected: true })!;
    const pinned = ringFor({ pinned: true })!;
    expect(ringFor({})).toBeNull();
    expect(seed.ringSize).toBeGreaterThan(selected.ringSize);
    expect(seed.gapSize).toBe(0);
    expect(selected.gapSize).toBe(0);
    expect(pinned.gapSize).toBeGreaterThan(0);
    // Three SHAPES, not three colours.
    const shapes = new Set([seed, selected, pinned].map((r) => `${r.ringSize}/${r.gapSize}`));
    expect(shapes.size).toBe(3);
  });

  it('the selection wins over a seed, which wins over a pin', () => {
    expect(ringFor({ selected: true, isSeed: true, pinned: true })).toEqual(ringFor({ selected: true }));
    expect(ringFor({ isSeed: true, pinned: true })).toEqual(ringFor({ isSeed: true }));
  });
});

describe('edges', () => {
  it('width is log(1 + evidenceCount) when it is present', () => {
    expect(edgeWidth(0, 0.9)).toBe(1);
    expect(edgeWidth(1)).toBeCloseTo(1 + 1.1 * Math.log(2), 2);
    expect(edgeWidth(10)).toBeGreaterThan(edgeWidth(3));
    expect(edgeWidth(1_000_000)).toBe(6);
  });

  it('falls back to confidence while evidenceCount is absent (#671 not landed), then to a constant', () => {
    expect(edgeWidth(undefined, 0)).toBe(1);
    expect(edgeWidth(null, 1)).toBe(2.5);
    expect(edgeWidth(undefined, 0.8)).toBeGreaterThan(edgeWidth(undefined, 0.2));
    expect(edgeWidth(undefined, undefined)).toBe(1.5);
    expect(edgeWidth(null, null)).toBe(1.5);
  });

  it('the INVOLVED_IN stance has its accent: champion green, supportive teal, neutral grey, skeptical amber, resistant red', () => {
    const color = (stance: string, mode: ExplorerMode = 'light') =>
      edgeAppearance(
        { relationType: 'INVOLVED_IN', confidence: 0.9, virtual: false, props: { stance } },
        '#999999',
        mode,
      ).color;
    expect(color('champion')).toBe(STANCE_COLORS.light.champion);
    expect(color('supportive')).toBe(STANCE_COLORS.light.supportive);
    expect(color('neutral')).toBe(STANCE_COLORS.light.neutral);
    expect(color('skeptical')).toBe(STANCE_COLORS.light.skeptical);
    expect(color('resistant', 'dark')).toBe(STANCE_COLORS.dark.resistant);
    expect(new Set(STANCES.map((s) => STANCE_COLORS.light[s])).size).toBe(5);
    expect(new Set(STANCES.map((s) => STANCE_COLORS.dark[s])).size).toBe(5);
  });

  it.each(MODES)('every %s stance colour has 3:1 contrast against the canvas', (mode) => {
    for (const stance of STANCES) {
      for (const background of VALIDATION_BACKGROUNDS[mode]) {
        expect(contrastRatio(STANCE_COLORS[mode][stance], background), `${stance} on ${background}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('only INVOLVED_IN takes a stance accent; an unknown stance is ignored; resistant and derived edges are flagged dashed', () => {
    const base = '#999999';
    const other = edgeAppearance({ relationType: 'WORKS_FOR', confidence: 1, virtual: false, props: { stance: 'champion' } }, base);
    expect(other.color).toBe(base);
    expect(other.stance).toBeNull();
    const unknown = edgeAppearance({ relationType: 'INVOLVED_IN', confidence: 1, virtual: false, props: { stance: 'loves' } }, base);
    expect(unknown.color).toBe(base);
    const resistant = edgeAppearance({ relationType: 'INVOLVED_IN', confidence: 1, virtual: false, props: { stance: 'resistant' } }, base);
    expect(resistant.dashed).toBe(true);
    expect(resistant.stance).toBe('resistant');
    const derived = edgeAppearance({ relationType: 'ASSIGNED_TO', confidence: null, virtual: true }, base);
    expect(derived.dashed).toBe(true);
    expect(derived.color).not.toBe(base);
    expect(edgeAppearance({ relationType: 'WORKS_FOR', confidence: 1, virtual: false }, base).dashed).toBe(false);
  });

  it('reads the stance case-insensitively and only from a string', () => {
    expect(stanceOf({ stance: 'Champion' })).toBe('champion');
    expect(stanceOf({ stance: 3 })).toBeNull();
    expect(stanceOf(undefined)).toBeNull();
  });

  it('labels: relation, then role or stage, then stance', () => {
    expect(edgeLabel('WORKS_FOR', {})).toBe('Works for');
    expect(edgeLabel('INVOLVED_IN', { role: 'sponsor', stance: 'champion' })).toBe('Involved in · Sponsor · champion');
    expect(edgeLabel('USES', { stage: 'pilot' })).toBe('Uses · Pilot');
  });
});

describe('parallelCurvatures', () => {
  it('one edge is straight; a bundle is centred on zero and separated', () => {
    expect(parallelCurvatures(1)).toEqual([0]);
    expect(parallelCurvatures(2)).toEqual([-0.15, 0.15]);
    expect(parallelCurvatures(3)).toEqual([-0.3, 0, 0.3]);
    const five = parallelCurvatures(5);
    expect(new Set(five).size).toBe(5);
    expect(five.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 5);
  });
});
