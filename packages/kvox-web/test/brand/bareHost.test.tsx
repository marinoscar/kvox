/**
 * A host with no API and no `public/` folder (KVox Desktop's renderer) gets the
 * KVox look from this entry alone: `ShellRoot` + `createKvoxTheme` + `BrandLockup`
 * (issue #628, acceptance criterion).
 */

import { Button } from '@mui/material';
import { ShellRoot } from '@marinoscar/platform-web/shell/ui';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandLockup, KVOX_BRAND, createKvoxTheme, kvoxTokens } from '../../src/brand/index.js';

const THEMES = { light: createKvoxTheme('light'), dark: createKvoxTheme('dark') };

describe('a bare host', () => {
  it('renders the lockup and sentence-case buttons under ShellRoot without any request', () => {
    const requests: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      requests.push(args);
      return Promise.reject(new Error('no network in a bare host'));
    }) as typeof fetch;
    try {
      localStorage.setItem('kvox-brand-test', 'dark');
      render(
        <ShellRoot themes={THEMES} storageKey="kvox-brand-test">
          <BrandLockup />
          <Button>Save changes</Button>
        </ShellRoot>,
      );

      expect(screen.getByText(KVOX_BRAND.productName)).toBeInTheDocument();
      const mark = screen.getByTestId('kvox-brand-mark');
      expect(mark.querySelector('rect')).toHaveAttribute('fill', kvoxTokens.brand.indigo);
      expect(document.querySelector('img')).toBeNull();

      const button = screen.getByRole('button', { name: 'Save changes' });
      expect(getComputedStyle(button).textTransform).toBe('none');
      expect(getComputedStyle(button).fontFamily).toMatch(/^"?Inter"?/);
      expect(requests).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      localStorage.removeItem('kvox-brand-test');
    }
  });
});
