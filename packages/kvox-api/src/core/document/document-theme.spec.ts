import { BRAND_TOKENS, KVOX_IDENTITY, MARK_ACCENT } from '@marinoscar/kvox-contract/brand';

import { KVOX_DOCUMENT_THEME, docxColor, mixHex } from './document-theme.js';

describe('KVOX_DOCUMENT_THEME', () => {
  const light = BRAND_TOKENS.light;

  it('is derived from the light brand tokens', () => {
    expect(KVOX_DOCUMENT_THEME).toMatchObject({
      primary: light.primary.main,
      primaryDark: light.primary.dark,
      primaryLight: light.primary.light,
      accent: MARK_ACCENT,
      accentDark: light.secondary.main,
      ink: light.text.primary,
      muted: light.text.secondary,
      faint: light.text.disabled,
      divider: light.divider,
      surface: light.background.default,
      paper: light.background.paper,
      onPrimary: light.primary.contrastText,
      link: light.primary.main,
    });
    expect(KVOX_DOCUMENT_THEME.primary).toBe(KVOX_IDENTITY.themeColor);
  });

  it('computes the tints over white', () => {
    expect(KVOX_DOCUMENT_THEME.primaryTint).toBe(mixHex(light.primary.main, '#ffffff', 0.08));
    expect(KVOX_DOCUMENT_THEME.primarySoft).toBe(mixHex(light.primary.main, '#ffffff', 0.16));
  });

  it('holds only lowercase #rrggbb values', () => {
    for (const value of Object.values(KVOX_DOCUMENT_THEME)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('mixHex and docxColor', () => {
  it('mixes at the extremes and the middle', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('strips the hash and uppercases', () => {
    expect(docxColor('#4f46e5')).toBe('4F46E5');
    expect(docxColor('#abc')).toBe('AABBCC');
  });

  it('rejects a non-colour', () => {
    expect(() => docxColor('indigo')).toThrow();
  });
});
