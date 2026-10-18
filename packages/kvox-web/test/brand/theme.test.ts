/**
 * The KVox theme (issue #628): the palette per mode, sentence-case buttons, Inter
 * first in the font stack, the bordered shadowless dark card, and the tokens'
 * link to `packages/shared/identity.json`.
 *
 * `apps/web/src/__tests__/theme/tokens.test.ts` keeps the WCAG contrast pairs of
 * these tokens; this file pins the package's own contract, so a host other than
 * the web app has the same guarantees without the web app's test utilities.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KVOX_BRAND,
  createKvoxTheme,
  kvoxComponentOverrides,
  kvoxDarkPalette,
  kvoxDarkTheme,
  kvoxLightPalette,
  kvoxLightTheme,
  kvoxTokens,
} from '../../src/brand/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY = JSON.parse(
  readFileSync(join(HERE, '..', '..', '..', 'shared', 'identity.json'), 'utf8'),
) as Record<string, string>;

describe('identity', () => {
  // The generated file is a copy; `npm run brand:check` is the CI gate, and this
  // is the same comparison where `npm run test:run` finds it.
  it.each(['productName', 'tagline', 'themeColor', 'backgroundColor'] as const)(
    'KVOX_BRAND.%s is the value in packages/shared/identity.json',
    (key) => {
      expect(KVOX_BRAND[key]).toBe(IDENTITY[key]);
    },
  );

  it('the light primary and the mark plate are the manifest colour, as a lowercase 6-digit hex', () => {
    expect(kvoxTokens.light.primary.main).toBe(IDENTITY.themeColor);
    expect(kvoxTokens.brand.indigo).toBe(IDENTITY.themeColor);
    expect(IDENTITY.themeColor).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('palettes', () => {
  it('light: the brand indigo on a tinted ground with white paper', () => {
    expect(kvoxLightPalette.primary).toMatchObject({
      main: IDENTITY.themeColor,
      light: '#818cf8',
      dark: '#4338ca',
      contrastText: '#ffffff',
    });
    expect(kvoxLightPalette.background).toEqual({ default: '#f6f7fb', paper: '#ffffff' });
    expect(kvoxLightPalette.divider).toBe('#e1e4ee');
    expect(kvoxLightTheme.palette.mode).toBe('light');
    expect(kvoxLightTheme.palette.primary.main).toBe(IDENTITY.themeColor);
  });

  it('dark: a chosen indigo tint on the #0f1117 ground with #171a23 paper', () => {
    expect(kvoxDarkPalette.primary).toMatchObject({ main: '#a5b4fc', light: '#c7d2fe', dark: '#818cf8' });
    expect(kvoxDarkPalette.secondary).toMatchObject({ main: '#fbbf24' });
    expect(kvoxDarkPalette.background).toEqual({ default: '#0f1117', paper: '#171a23' });
    expect(kvoxTokens.dark.elevated).toBe('#1e222d');
    expect(kvoxDarkTheme.palette.mode).toBe('dark');
    expect(kvoxDarkTheme.palette.background.paper).toBe('#171a23');
  });

  it('the mark accent is the dark secondary, the amber of the brand', () => {
    expect(kvoxTokens.brand.amber).toBe('#fbbf24');
    expect(kvoxTokens.brand.amber).toBe(kvoxTokens.dark.secondary.main);
  });

  it('the selection and hover washes are tinted with the primary hue', () => {
    expect(kvoxLightTheme.palette.action.selected).toBe('rgba(79, 70, 229, 0.08)');
    expect(kvoxLightTheme.palette.action.hover).toBe('rgba(79, 70, 229, 0.04)');
    expect(kvoxDarkTheme.palette.action.selected).toMatch(/^rgba\(165, 180, 252, /);
  });
});

describe('typography and shape (the shell base)', () => {
  it.each([
    ['light', kvoxLightTheme],
    ['dark', kvoxDarkTheme],
  ] as const)('%s: Inter is the first family, with 600-weight headings', (_mode, theme) => {
    expect(theme.typography.fontFamily?.split(',')[0]?.replaceAll('"', '').trim()).toBe('Inter');
    expect(theme.typography.h1.fontWeight).toBe(600);
  });
});

describe('component overrides', () => {
  it.each(['light', 'dark'] as const)('%s: buttons are sentence case at weight 500', (mode) => {
    const theme = createKvoxTheme(mode);
    const root = theme.components?.MuiButton?.styleOverrides?.root as Record<string, unknown>;

    expect(root).toMatchObject({ textTransform: 'none', fontWeight: 500 });
  });

  it('dark: a card has a divider border and no shadow', () => {
    const root = kvoxDarkTheme.components?.MuiCard?.styleOverrides?.root as (arg: unknown) => Record<string, unknown>;

    expect(root({ theme: kvoxDarkTheme })).toEqual({
      boxShadow: 'none',
      border: `1px solid ${kvoxDarkTheme.palette.divider}`,
    });
  });

  it('light: a card has the single hairline shadow and no border', () => {
    const root = kvoxLightTheme.components?.MuiCard?.styleOverrides?.root as (arg: unknown) => Record<string, unknown>;

    expect(root({ theme: kvoxLightTheme })).toEqual({ boxShadow: '0 1px 2px rgba(16,24,40,0.06)' });
  });

  it('the AppBar is flat with a divider underline in both modes', () => {
    for (const theme of [kvoxLightTheme, kvoxDarkTheme]) {
      const root = theme.components?.MuiAppBar?.styleOverrides?.root as (arg: unknown) => Record<string, unknown>;
      expect(root({ theme })).toEqual({
        boxShadow: 'none',
        borderBottom: `1px solid ${theme.palette.divider}`,
      });
    }
  });

  it('kvoxComponentOverrides(mode) is the set the themes carry', () => {
    for (const mode of ['light', 'dark'] as const) {
      expect(Object.keys(kvoxComponentOverrides(mode) ?? {})).toEqual(
        Object.keys(createKvoxTheme(mode).components ?? {}),
      );
    }
  });
});

describe('createKvoxTheme', () => {
  it('builds a fresh theme per call and the module constants are stable', () => {
    expect(createKvoxTheme('dark')).not.toBe(kvoxDarkTheme);
    expect(createKvoxTheme('dark').palette.primary.main).toBe(kvoxDarkTheme.palette.primary.main);
  });

  it('merges `extend` over the result without losing the KVox palette', () => {
    const theme = createKvoxTheme('light', { shape: { borderRadius: 2 }, palette: { warning: { main: '#123456' } } });

    expect(theme.shape.borderRadius).toBe(2);
    expect(theme.palette.warning.main).toBe('#123456');
    expect(theme.palette.primary.main).toBe(IDENTITY.themeColor);
    expect(theme.components?.MuiButton).toBeDefined();
  });
});
