import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { render, mockAdminUser, mockUser } from './helpers.js';
import { fakeApiError } from '../../src/core/testing/index.js';
import type { FakeRoute } from '../../src/core/testing/index.js';
import { ImportTranscriptButton } from '../../src/transcripts/ui/components/ImportTranscriptButton.js';
import { TranscriptsPage } from '../../src/transcripts/ui/pages/TranscriptsPage.js';
import { TRANSCRIPT_IMPORT_MAX_BYTES } from '../../src/transcripts/headless/clients/transcriptImports.js';

/**
 * The "Import transcript (JSON)" action (#571), over the fake host. Synthetic data only.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const IMPORTED = {
  id: 'imp-1',
  title: 'Synthetic standup',
  status: 'ready',
  transcriptionStatus: 'completed',
  playbackStatus: 'not_needed',
  language: 'en',
  durationMs: 60_000,
  speakerCount: 1,
  wordCount: 12,
  currentVersion: 1,
  failureReason: null,
  access: 'owner',
  ownerName: 'Admin User',
  hasAudio: false,
  recordedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  speakers: [],
  provider: 'import',
  remoteDeletedAt: null,
  submittedAt: null,
  completedAt: null,
  sourceName: 'standup.json',
  sourceMimeType: 'application/json',
  sourceSizeBytes: '64',
};

function jsonFile(): File {
  return new File(['{"schema":"kvox.transcript/v1"}'], 'standup.json', { type: 'application/json' });
}

function renderButton(route: FakeRoute, user = mockAdminUser) {
  return render(<ImportTranscriptButton />, {
    wrapperOptions: { user, route: '/transcripts/new' },
    hostOptions: { routes: { 'POST /transcripts/imports': route } },
  });
}

beforeEach(() => {
  mockNavigate.mockReset();
});

describe('ImportTranscriptButton', () => {
  it('imports the chosen file and opens the new transcript', async () => {
    const { host } = renderButton(() => IMPORTED);

    await userEvent.upload(screen.getByLabelText('Choose a transcript JSON file'), jsonFile());

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/transcripts/imp-1'));
    expect(host.callsTo('POST /transcripts/imports')).toHaveLength(1);
  });

  it('shows the friendly message for a file that is not a KVox export', async () => {
    renderButton(() => {
      throw fakeApiError(400, 'Bad Request', { reason: 'unsupported_schema' });
    });

    await userEvent.upload(screen.getByLabelText('Choose a transcript JSON file'), jsonFile());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This isn't a KVox transcript export (kvox.transcript/v1).",
    );
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Import transcript (JSON)' })).toBeEnabled();
  });

  it('refuses an oversized file without sending it', async () => {
    const { host } = renderButton(() => IMPORTED);
    const big = jsonFile();
    Object.defineProperty(big, 'size', { value: TRANSCRIPT_IMPORT_MAX_BYTES + 1 });

    await userEvent.upload(screen.getByLabelText('Choose a transcript JSON file'), big);

    expect(await screen.findByRole('alert')).toHaveTextContent(/too large to import/);
    expect(host.callsTo('POST /transcripts/imports')).toHaveLength(0);
  });

  it('shows a busy state while the import runs', async () => {
    let finish: (value: unknown) => void = () => {};
    renderButton(() => new Promise((resolve) => (finish = resolve)));

    await userEvent.upload(screen.getByLabelText('Choose a transcript JSON file'), jsonFile());

    expect(await screen.findByRole('button', { name: 'Importing…' })).toBeDisabled();
    finish(IMPORTED);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
  });

  it('is not offered without transcripts:write', () => {
    renderButton(() => IMPORTED, mockUser);

    expect(screen.queryByRole('button', { name: 'Import transcript (JSON)' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Choose a transcript JSON file')).not.toBeInTheDocument();
  });

  it('accepts JSON only and has no axe violations', async () => {
    const { container } = renderButton(() => IMPORTED);

    expect(screen.getByLabelText('Choose a transcript JSON file')).toHaveAttribute(
      'accept',
      '.json,application/json',
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('TranscriptsPage — the import action', () => {
  it('sits in the header beside "New transcript"', async () => {
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
      hostOptions: {
        routes: {
          'GET /transcripts': { items: [], total: 0, nextCursor: null },
          'POST /transcripts/imports': IMPORTED,
        },
      },
    });

    expect(await screen.findByRole('button', { name: 'Import transcript (JSON)' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New transcript' }).length).toBeGreaterThan(0);

    await userEvent.upload(screen.getByLabelText('Choose a transcript JSON file'), jsonFile());
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/transcripts/imp-1'));
  });
});
