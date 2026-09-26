/**
 * `RecordedAtDialog` (issue #352).
 *
 * `updateTranscript` is wrapped rather than replaced: by default it is the REAL
 * service over the MSW `PATCH /api/transcripts/:id` echo handler, so a save
 * exercises the wire round trip (ISO instant out, the server's normalised
 * instant back), while the spy still lets a test assert exactly what was sent.
 *
 * The local-zone assertions are written against the local getters rather than
 * a literal wall-clock string, so they hold in whatever `TZ` the suite runs in
 * — and fail in any zone but UTC if the dialog ever regresses to slicing
 * `toISOString()`, which is the bug they exist to catch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

vi.mock('../../../services/transcripts', async () => {
  const actual = await vi.importActual<typeof import('../../../services/transcripts')>(
    '../../../services/transcripts',
  );
  return { ...actual, updateTranscript: vi.fn(actual.updateTranscript) };
});

import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { updateTranscript } from '../../../services/transcripts';
import type { TranscriptDetail } from '../../../services/transcripts';
import {
  RECORDED_AT_HELPER_TEXT,
  RecordedAtDialog,
  recordedAtError,
  toLocalInputValue,
} from '../../../components/transcripts/RecordedAtDialog';

const mockUpdate = vi.mocked(updateTranscript);

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const RECORDED_AT = '2026-03-02T20:00:00.000Z';

function detail(overrides: Partial<TranscriptDetail> = {}): TranscriptDetail {
  return {
    id: 't1',
    title: 'Weekly standup',
    status: 'ready',
    transcriptionStatus: 'completed',
    playbackStatus: 'ready',
    language: 'en',
    durationMs: 600_000,
    speakerCount: 2,
    wordCount: 1200,
    currentVersion: 1,
    failureReason: null,
    access: 'owner',
    ownerName: 'Test User',
    recordedAt: RECORDED_AT,
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
    speakers: [],
    provider: 'AssemblyAI',
    remoteDeletedAt: null,
    submittedAt: null,
    completedAt: null,
    sourceName: 'standup.m4a',
    sourceMimeType: 'audio/mp4',
    sourceSizeBytes: '1048576',
    ...overrides,
  };
}

/** The `datetime-local` value an instant should show, in this process's zone. */
function expectedLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderDialog(props: Partial<React.ComponentProps<typeof RecordedAtDialog>> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const utils = render(
    <RecordedAtDialog
      open
      onClose={onClose}
      onSaved={onSaved}
      transcript={detail()}
      {...props}
    />,
  );
  return { ...utils, onClose, onSaved };
}

const field = () => screen.getByLabelText('Recorded at') as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: 'Save' });

beforeEach(() => {
  mockUpdate.mockClear();
});

describe('RecordedAtDialog — local zone', () => {
  it('pre-fills the recording date in the browser’s local zone', () => {
    renderDialog();
    expect(field()).toHaveAttribute('type', 'datetime-local');
    expect(field().value).toBe(expectedLocal(RECORDED_AT));
  });

  it('round-trips: the pre-filled local value parses back to the same instant', () => {
    const local = toLocalInputValue(RECORDED_AT);
    expect(local).toBe(expectedLocal(RECORDED_AT));
    expect(new Date(local).toISOString()).toBe(RECORDED_AT);
  });

  it('shows the helper text explaining why the date matters', () => {
    renderDialog();
    expect(screen.getByText(RECORDED_AT_HELPER_TEXT)).toBeInTheDocument();
  });
});

describe('RecordedAtDialog — validation', () => {
  it('rejects a date more than 24 hours in the future and disables Save', () => {
    renderDialog();
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    fireEvent.change(field(), { target: { value: toLocalInputValue(future) } });

    expect(screen.getByText('A recording cannot be dated in the future.')).toBeInTheDocument();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton()).toBeDisabled();
  });

  it('allows a date within the 24-hour slack', () => {
    const now = Date.parse('2026-05-01T12:00:00.000Z');
    const soon = toLocalInputValue(new Date(now + 60 * 60 * 1000).toISOString());
    expect(recordedAtError(soon, now)).toBeNull();
  });

  it('rejects an empty value and disables Save', () => {
    renderDialog();
    fireEvent.change(field(), { target: { value: '' } });

    expect(
      screen.getByText('Enter the date and time the recording was made.'),
    ).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });
});

describe('RecordedAtDialog — saving', () => {
  it('sends the local value as an ISO instant and hands the result to onSaved', async () => {
    const user = userEvent.setup();
    const { onSaved, onClose } = renderDialog();
    const local = '2025-11-05T14:30';
    fireEvent.change(field(), { target: { value: local } });

    await user.click(saveButton());

    const iso = new Date(local).toISOString();
    expect(mockUpdate).toHaveBeenCalledWith('t1', { recordedAt: iso });
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0][0]).toMatchObject({ id: 't1', recordedAt: iso });
    expect(onClose).toHaveBeenCalled();
  });

  it('disables Save while the request is in flight', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    server.use(
      http.patch('*/api/transcripts/:id', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({ data: detail() });
      }),
    );
    const { onSaved } = renderDialog();

    await user.click(saveButton());
    expect(saveButton()).toBeDisabled();

    release();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('shows the API’s error in an Alert and stays open', async () => {
    const user = userEvent.setup();
    server.use(
      http.patch('*/api/transcripts/:id', () =>
        HttpResponse.json(
          { message: 'A recording cannot be dated in the future.' },
          { status: 400 },
        ),
      ),
    );
    const { onSaved, onClose } = renderDialog();

    await user.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A recording cannot be dated in the future.');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton()).toBeEnabled();
  });
});

describe('RecordedAtDialog — accessibility', () => {
  it('has no axe violations', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Edit recording date' });
    const results = await axe(dialog, AXE_OPTIONS);
    expect(results).toHaveNoViolations();
  });
});
