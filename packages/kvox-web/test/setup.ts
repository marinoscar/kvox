import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { setPreferredTimeZone } from '@marinoscar/platform-web/timezone/headless';

import { installMatchMedia, resetViewportWidth } from '../src/core/testing/viewport.js';

// jsdom has no matchMedia; the query-aware one lets a test drive MUI breakpoints.
installMatchMedia();

afterEach(() => {
  cleanup();
  // A test that chose a display zone must not leak it into the next one; the
  // device's zone (UTC, `vitest.config.ts`) is the default again.
  setPreferredTimeZone(null);
  resetViewportWidth();
  installMatchMedia();
});
