/**
 * The explorer's visual language (#667, epic #661): which colour, pictogram,
 * size, ring and edge style says what. PURE: no React, no sigma, no graphology
 * instance, so every rule is a plain unit test (jsdom has no WebGL).
 *
 * THREE CHANNELS FOR TYPE, never one. Colour alone fails colour-blind users, so
 * a node's type is also its pictogram (`icons/pictograms.ts`) and, in the
 * legend, its label. Size says how much the node matters (mentions, else
 * degree); rings say what the USER did with it (seed, pinned, selected).
 *
 * THE PALETTE IS FIXED AND VALIDATED, not derived from the MUI theme: a theme's
 * `primary`/`secondary`/… are brand colours chosen for UI chrome, so two of them
 * can sit a few degrees apart. `CATEGORICAL_PALETTE` was searched for pairwise
 * distinctness under simulated deuteranopia and for ≥ 3:1 contrast against the
 * light AND dark canvas backgrounds (WCAG 1.4.11, graphical objects);
 * `explorerEncoding.test.ts` re-checks both on every run. Only the light or dark
 * VARIANT follows the theme (`palette.mode`).
 *
 * TYPES THAT DO NOT EXIST YET. `Topic`, `Product` and `Risk` (#662 to #664) have
 * explicit table entries, so the day the ontology gains them they are encoded
 * with no further change. Any other key, a user type included, takes a
 * deterministic fallback: the colour from a hash of the key, the generic
 * pictogram.
 */

import { alpha } from '@mui/material/styles';

import { humanizeKey } from '../../../headless/utils/graphDisplay.js';
import type { GraphOntology } from '../../../headless/clients/graph.js';
import { pictogramDataUri, type PictogramName } from './icons/pictograms.js';

/**
 * The theme variant the encoding is drawn for.
 *
 * @stability experimental
 */
export type ExplorerMode = 'light' | 'dark';

/**
 * Categorical node colours, one list per theme variant, in assignment order.
 * Fourteen slots: the thirteen shipped-and-planned types, and one spare.
 *
 * Found by a greedy farthest-point search over a pool that already satisfied the
 * contrast floor, scored on simulated deuteranopia (Machado 2009, severity 1)
 * and normal vision. Do not hand-edit one entry: the test fails on the weakest
 * pair, and a replacement has to be searched, not eyeballed.
 */
export const CATEGORICAL_PALETTE: Readonly<Record<ExplorerMode, readonly string[]>> = {
  light: [
    '#0d66a5', '#509720', '#7a2949', '#2b2bca', '#2293a0', '#1b1b7e', '#871d1d',
    '#339966', '#2b5bca', '#7e1b74', '#b83d7a', '#263673', '#209744', '#278db9',
  ],
  dark: [
    '#4cacf0', '#6fd22d', '#d43575', '#81e4e4', '#81e495', '#4663d8', '#bf5940',
    '#bf40a6', '#dae481', '#6ecfa8', '#4073bf', '#70bfe1', '#d175ac', '#62c757',
  ],
};

/** The canvas backgrounds the palette is validated against (MUI's own defaults and a lifted dark surface). */
export const VALIDATION_BACKGROUNDS: Readonly<Record<ExplorerMode, readonly string[]>> = {
  light: ['#ffffff', '#f5f5f5'],
  dark: ['#121212', '#1e1e1e', '#000000'],
};

/** WCAG 1.4.11: the floor for a graphical object. */
export const MIN_GRAPHICAL_CONTRAST = 3;

/**
 * The types with a place of their own, in slot order. The key is normalised
 * (`normalizeTypeKey`), so `Risk` (an entity type) and `risk` (an item kind)
 * share one entry. Append, never reorder: a slot is a colour people learn.
 */
const KNOWN_TYPES: readonly { key: string; icon: PictogramName }[] = [
  { key: 'person', icon: 'person' },
  { key: 'organization', icon: 'building' },
  { key: 'project', icon: 'flag' },
  { key: 'meeting', icon: 'calendar' },
  { key: 'topic', icon: 'tag' },
  { key: 'product', icon: 'cube' },
  { key: 'commitment', icon: 'check-circle' },
  { key: 'decision', icon: 'gavel' },
  { key: 'risk', icon: 'warning' },
  { key: 'claim', icon: 'quote' },
  { key: 'interest', icon: 'star' },
  { key: 'trip', icon: 'plane' },
  { key: 'milestone', icon: 'milestone' },
];

/** `Person`, `person` and `PERSON` are one type; `person_fact` and `PersonFact` too. */
export function normalizeTypeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** FNV-1a, 32 bit: a stable, dependency-free string hash for the fallback slot. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** How one node type is drawn. */
export interface TypeEncoding {
  /** Normalised type key. */
  key: string;
  /** Index into {@link CATEGORICAL_PALETTE}. */
  slot: number;
  /** Fill colour for the theme variant. */
  color: string;
  /** The pictogram's name. */
  icon: PictogramName;
  /** The pictogram's colour: white or near-black, whichever reads on `color`. */
  iconColor: string;
  /** `false` for a type with no table entry (hashed colour, generic pictogram). */
  known: boolean;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** `#rrggbb` to `[r, g, b]`; `null` for anything else (an `rgba()` string, a name). */
export function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of a `#rrggbb`. */
export function relativeLuminance(color: string): number {
  const rgb = parseHex(color);
  if (!rgb) return 0;
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** White or near-black, whichever has the higher contrast on `fill`. */
export function readableOn(fill: string): string {
  return contrastRatio('#ffffff', fill) >= contrastRatio('#111111', fill) ? '#ffffff' : '#111111';
}

/**
 * How a node type is drawn in a theme variant. Known types take their table
 * slot; anything else hashes into the palette, with the generic pictogram.
 * Total: it never throws and never returns grey.
 */
export function encodingFor(type: string, mode: ExplorerMode = 'light'): TypeEncoding {
  const key = normalizeTypeKey(type);
  const index = KNOWN_TYPES.findIndex((entry) => entry.key === key);
  const palette = CATEGORICAL_PALETTE[mode];
  const known = index >= 0;
  const slot = known ? index : hash(key) % palette.length;
  const color = palette[slot];
  return {
    key,
    slot,
    color,
    icon: known ? KNOWN_TYPES[index].icon : 'generic',
    iconColor: readableOn(color),
    known,
  };
}

/** The type keys of an ontology that nodes can carry: an entity type's key, an item type's kind. Person facts never reach a slice. */
export function ontologyNodeTypes(ontology: GraphOntology): string[] {
  const keys: string[] = [];
  for (const type of ontology.entityTypes) {
    if (type.deprecated) continue;
    const key = type.storage === 'item' ? type.itemKind : type.key;
    if (!key || normalizeTypeKey(key) === 'personfact' || keys.includes(key)) continue;
    keys.push(key);
  }
  return keys;
}

/** The `data:` URL of a type's pictogram, for `@sigma/node-image`. */
export function iconUrlFor(type: string, mode: ExplorerMode = 'light'): string {
  return pictogramDataUri(encodingFor(type, mode).icon);
}

// -----------------------------------------------------------------------------
// Node size
// -----------------------------------------------------------------------------

/** Smallest and largest drawn node radius. A pictogram needs about 6px to read. */
export const NODE_SIZE_MIN = 6;
export const NODE_SIZE_MAX = 22;

/** What decides a node's size. */
export interface NodeSizeInput {
  /** How many notes mention it, when the API says; the better signal. */
  mentionCount?: number | null;
  /** Readable relations in the whole graph; the fallback. */
  degree: number;
  /** Items draw at four-fifths of an entity. */
  nodeKind?: 'entity' | 'item';
}

/**
 * `6 + 1.6·√n` where `n` is `mentionCount` (else `degree`), clamped to
 * `[NODE_SIZE_MIN, max]`; an item is four-fifths of that. A square root keeps a
 * 100-mention hub about three times a one-mention node, not thirty. `max` is how
 * a phone's budget lowers the ceiling (GIC-08).
 */
export function nodeSize(input: NodeSizeInput, max: number = NODE_SIZE_MAX): number {
  const n = Math.max(0, input.mentionCount ?? input.degree);
  const base = Math.min(max, NODE_SIZE_MIN + 1.6 * Math.sqrt(n));
  const size = input.nodeKind === 'item' ? base * 0.8 : base;
  return Math.round(Math.max(NODE_SIZE_MIN * 0.8, size) * 100) / 100;
}

// -----------------------------------------------------------------------------
// Rings
// -----------------------------------------------------------------------------

/** What the user did to a node; each is a different SHAPE of ring, never only a colour. */
export interface RingState {
  /** The exploration started here. */
  isSeed?: boolean;
  /** Dragged into place: the layout leaves it where it is. */
  pinned?: boolean;
  /** The inspector is showing it. */
  selected?: boolean;
}

/** `@sigma/node-border` sizes, as a fraction of the node's radius. */
export interface RingAttributes {
  /** Width of the ring. */
  ringSize: number;
  /** Transparent gap between the disc and the ring (a pinned node's "detached" ring). */
  gapSize: number;
}

/**
 * Seed: a thick ring. Pinned: a thin ring set off by a gap, the stand-in for the
 * issue's dashed ring (a WebGL node program cannot dash). Selected: a thin ring.
 * Precedence when several apply: selected over seed over pinned, because the
 * selection is the one the user is looking at.
 */
export function ringFor(state: RingState): RingAttributes | null {
  if (state.selected) return { ringSize: 0.14, gapSize: 0 };
  if (state.isSeed) return { ringSize: 0.3, gapSize: 0 };
  if (state.pinned) return { ringSize: 0.12, gapSize: 0.14 };
  return null;
}

// -----------------------------------------------------------------------------
// Edges
// -----------------------------------------------------------------------------

/** The five stances an `INVOLVED_IN` relation records. */
export const STANCES = ['champion', 'supportive', 'neutral', 'skeptical', 'resistant'] as const;
/** A stance an `INVOLVED_IN` relation records. */
export type Stance = (typeof STANCES)[number];

/** champion = green, supportive = teal, neutral = grey, skeptical = amber, resistant = red. */
export const STANCE_COLORS: Readonly<Record<ExplorerMode, Readonly<Record<Stance, string>>>> = {
  light: {
    champion: '#2e7d32',
    supportive: '#00796b',
    neutral: '#757575',
    skeptical: '#b26a00',
    resistant: '#c62828',
  },
  dark: {
    champion: '#66bb6a',
    supportive: '#4db6ac',
    neutral: '#9e9e9e',
    skeptical: '#ffb74d',
    resistant: '#ef5350',
  },
};

/** The stance a relation's props carry, or `null` for none or an unknown one. */
export function stanceOf(props: Record<string, unknown> | undefined | null): Stance | null {
  const value = props?.stance;
  if (typeof value !== 'string') return null;
  const key = value.toLowerCase();
  return (STANCES as readonly string[]).includes(key) ? (key as Stance) : null;
}

/** The relation type whose `stance` prop gets an accent. */
export const STANCE_RELATION = 'INVOLVED_IN';

/**
 * Edge width: `1 + 1.1·ln(1 + evidenceCount)` clamped to `[1, 6]` when the API
 * sends `evidenceCount` (#671); until then (or for a relation with none) the
 * extraction `confidence` gives `1 + 1.5·confidence`; with neither, 1.5.
 */
export function edgeWidth(evidenceCount?: number | null, confidence?: number | null): number {
  if (typeof evidenceCount === 'number' && evidenceCount >= 0) {
    return Math.round(Math.min(6, 1 + 1.1 * Math.log(1 + evidenceCount)) * 100) / 100;
  }
  if (typeof confidence === 'number') {
    return Math.round((1 + 1.5 * Math.min(1, Math.max(0, confidence))) * 100) / 100;
  }
  return 1.5;
}

/** The inputs of an edge's appearance. */
export interface EdgeAppearanceInput {
  relationType: string;
  confidence: number | null;
  evidenceCount?: number | null;
  virtual: boolean;
  props?: Record<string, unknown>;
}

/** How an edge is drawn. */
export interface EdgeAppearance {
  /** Line colour. */
  color: string;
  /** Line width. */
  size: number;
  /** The stance accent in effect, or `null`. */
  stance: Stance | null;
  /** Derived (virtual) edges and a `resistant` stance are meant to be dashed. */
  dashed: boolean;
  /** Text shown on hover or selection: the relation, its role or stage, its stance. */
  label: string;
}

/** `Works for`, plus `· Sponsor` for a role, `· Pilot` for a stage, `· champion` for a stance. */
export function edgeLabel(relationType: string, props: Record<string, unknown> | undefined | null): string {
  const parts = [humanizeKey(relationType)];
  for (const key of ['role', 'stage']) {
    const value = props?.[key];
    if (typeof value === 'string' && value.trim()) parts.push(humanizeKey(value.trim()));
  }
  const stance = stanceOf(props);
  if (stance) parts.push(stance);
  return parts.join(' · ');
}

/**
 * Colour, width, stance, dash and label of an edge. The base colour is the
 * theme's own `baseColor` (muted); an `INVOLVED_IN` edge with a known stance
 * takes the stance accent; a derived edge is drawn at 60% opacity (the dash
 * the issue asks for needs a custom WebGL program, tracked as a follow-up).
 */
export function edgeAppearance(
  edge: EdgeAppearanceInput,
  baseColor: string,
  mode: ExplorerMode = 'light',
): EdgeAppearance {
  const stance = edge.relationType === STANCE_RELATION ? stanceOf(edge.props) : null;
  const color = stance ? STANCE_COLORS[mode][stance] : baseColor;
  return {
    color: edge.virtual ? alpha(color, 0.6) : color,
    size: edgeWidth(edge.evidenceCount, edge.confidence),
    stance,
    dashed: edge.virtual || stance === 'resistant',
    label: edgeLabel(edge.relationType, edge.props),
  };
}

/** Distance between consecutive parallel edges' curvature. */
export const CURVATURE_STEP = 0.3;

/**
 * Curvatures for the `count` edges between one pair of nodes, centred on zero:
 * 1 edge is straight, 2 are `±0.15`, 3 are `-0.3, 0, 0.3`. `@sigma/edge-curve`
 * bends an edge to its own left, so an edge stored in the opposite direction
 * negates its value, and the whole bundle fans out on the same side.
 */
export function parallelCurvatures(count: number): number[] {
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, i) =>
    Math.round((i - (count - 1) / 2) * CURVATURE_STEP * 1000) / 1000,
  );
}
