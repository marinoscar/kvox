// =============================================================================
// KVOX_DOCUMENT_THEME: the print palette of exported documents
// =============================================================================
//
// A PDF or Word export is a printed object, so it paints the LIGHT palette of the
// brand tokens (`@marinoscar/kvox-contract/brand`), never the dark one. Every colour
// below is read from `BRAND_TOKENS.light`, `MARK_ACCENT` or computed from those
// (the two tints are the brand colour mixed over white, the way the web paints
// `action.selected` at alpha 0.08); the only literal is white. A rebrand therefore
// restyles the exports with no edit here.
// =============================================================================

import { BRAND_TOKENS, MARK_ACCENT } from '@marinoscar/kvox-contract/brand';

const WHITE = '#ffffff';

function parseHex(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(channels: readonly number[]): string {
  return `#${channels.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Mixes `foreground` over `background` at `amount` opacity (0 is all background, 1 all
 * foreground), channel by channel in sRGB, like an alpha-composited overlay.
 *
 * @param foreground - `#rgb` or `#rrggbb`.
 * @param background - `#rgb` or `#rrggbb`.
 * @param amount - the foreground's opacity, clamped to 0..1.
 * @returns a lowercase `#rrggbb`.
 * @stability experimental
 */
export function mixHex(foreground: string, background: string, amount: number): string {
  const a = Math.min(1, Math.max(0, amount));
  const f = parseHex(foreground);
  const b = parseHex(background);
  return toHex(f.map((c, i) => c * a + b[i]! * (1 - a)));
}

/**
 * A colour in the form the `docx` library wants: no `#`, uppercase (`4F46E5`).
 *
 * @param hex - `#rgb` or `#rrggbb`.
 * @stability experimental
 */
export function docxColor(hex: string): string {
  return toHex(parseHex(hex)).slice(1).toUpperCase();
}

/**
 * The colours of an exported document, all `#rrggbb` lowercase.
 *
 * @stability experimental
 */
export interface KvoxDocumentTheme {
  /** The brand colour: headings, rules, the title block. */
  readonly primary: string;
  /** The darker brand step. */
  readonly primaryDark: string;
  /** The lighter brand step. */
  readonly primaryLight: string;
  /** The brand colour at 8% over white: table banding, callout grounds. */
  readonly primaryTint: string;
  /** The brand colour at 16% over white: table headers, code panels. */
  readonly primarySoft: string;
  /** The amber of the mark's waveform. */
  readonly accent: string;
  /** The darker amber (readable as text on white). */
  readonly accentDark: string;
  /** Body text. */
  readonly ink: string;
  /** Supporting text. */
  readonly muted: string;
  /** Footers and the faintest text. */
  readonly faint: string;
  /** Hairlines and borders. */
  readonly divider: string;
  /** The page-ground tint (panels). */
  readonly surface: string;
  /** The paper (white). */
  readonly paper: string;
  /** The ink that reads on `primary`. */
  readonly onPrimary: string;
  /** Hyperlinks. */
  readonly link: string;
}

const L = BRAND_TOKENS.light;

/**
 * The print palette for exported documents, derived from the brand tokens.
 *
 * @stability experimental
 */
export const KVOX_DOCUMENT_THEME: KvoxDocumentTheme = Object.freeze({
  primary: L.primary.main,
  primaryDark: L.primary.dark,
  primaryLight: L.primary.light,
  primaryTint: mixHex(L.primary.main, WHITE, 0.08),
  primarySoft: mixHex(L.primary.main, WHITE, 0.16),
  accent: MARK_ACCENT,
  accentDark: L.secondary.main,
  ink: L.text.primary,
  muted: L.text.secondary,
  faint: L.text.disabled,
  divider: L.divider,
  surface: L.background.default,
  paper: L.background.paper,
  onPrimary: L.primary.contrastText,
  link: L.primary.main,
});
