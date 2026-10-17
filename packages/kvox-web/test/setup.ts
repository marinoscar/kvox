import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import { installMatchMedia, resetViewportWidth } from '../src/core/testing/viewport.js';

// jsdom has no matchMedia; the query-aware one lets a test drive MUI breakpoints.
installMatchMedia();

afterEach(() => {
  cleanup();
  resetViewportWidth();
  installMatchMedia();
});
