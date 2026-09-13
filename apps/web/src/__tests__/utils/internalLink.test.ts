import { describe, it, expect } from 'vitest';
import { isInternalLink } from '../../utils/internalLink';

/**
 * Issue #127, epic #109. `isInternalLink` is the client-side re-check of a
 * guarantee the API's `sanitizeLink` already enforces before a row is
 * written — see the extensive header of `utils/internalLink.ts`. It must
 * accept exactly root-relative paths and reject everything that could be an
 * open redirect: protocol-relative `//host`, an absolute URL with a scheme,
 * `javascript:`, and a bare relative path that would resolve against
 * whatever route the user happens to be on.
 */
describe('isInternalLink', () => {
  describe('accepts root-relative paths', () => {
    it.each([
      ['/settings', '/settings'],
      ['/admin/users?tab=roles', '/admin/users?tab=roles'],
      ['/x#frag', '/x#frag'],
    ])('accepts %s', (_label, link) => {
      expect(isInternalLink(link)).toBe(true);
    });
  });

  describe('rejects anything that could redirect off-origin or off-route', () => {
    it.each([
      ['protocol-relative URL', '//evil.example/x'],
      ['absolute https URL', 'https://evil.example'],
      ['javascript: scheme', 'javascript:alert(1)'],
      ['empty string', ''],
      ['bare relative path with no leading slash', 'settings'],
    ])('rejects %s', (_label, link) => {
      expect(isInternalLink(link)).toBe(false);
    });

    it('rejects null', () => {
      expect(isInternalLink(null)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isInternalLink(undefined)).toBe(false);
    });
  });

  it('narrows the type to string on a positive result (compile-time contract, checked at runtime too)', () => {
    const link: string | null = '/settings';
    if (isInternalLink(link)) {
      // If this compiles and runs, the type guard did its job.
      expect(link.length).toBeGreaterThan(0);
    } else {
      throw new Error('expected /settings to be treated as an internal link');
    }
  });
});
