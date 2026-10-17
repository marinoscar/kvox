import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { KvoxHostMissingError } from '../../src/core/headless/index.js';
import { TranscriptionSettingsPage } from '../../src/transcription/ui/index.js';

describe('TranscriptionSettingsPage without a host', () => {
  it('refuses to render, with a named error that says what to mount', () => {
    // React logs the error it re-throws; keep the test output quiet.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() =>
        render(
          <MemoryRouter>
            <TranscriptionSettingsPage />
          </MemoryRouter>,
        ),
      ).toThrow(KvoxHostMissingError);
      expect(() =>
        render(
          <MemoryRouter>
            <TranscriptionSettingsPage />
          </MemoryRouter>,
        ),
      ).toThrow(/KvoxWebHostProvider/);
    } finally {
      spy.mockRestore();
    }
  });
});
