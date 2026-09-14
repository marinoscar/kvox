import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../services/transcription', () => ({ getTranscriptionConfig: vi.fn() }));
vi.mock('../../services/transcripts', () => ({ createTranscript: vi.fn() }));
vi.mock('../../hooks/useUploadManager', () => ({ useUploadManager: vi.fn() }));

import { render, mockAdminUser, mockUser } from '../utils/test-utils';
import { ApiError } from '../../services/api';
import NewTranscriptPage from '../../pages/NewTranscriptPage';
import { getTranscriptionConfig } from '../../services/transcription';
import { createTranscript } from '../../services/transcripts';
import { useUploadManager } from '../../hooks/useUploadManager';
import type { ManagedUpload } from '../../contexts/UploadManagerContext';

/**
 * The New-transcript flow.
 *
 * `useUploadManager` is MOCKED rather than stood up for real, which the hook's
 * own header anticipates: the manager owns `XMLHttpRequest`s, IndexedDB
 * sessions and a wake lock, none of which this screen's behaviour depends on.
 * What the screen is responsible for is the three things asserted below —
 * refusing a file it should refuse, handing the manager the upload the API
 * already created, and navigating when that upload finishes.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const mockGetConfig = vi.mocked(getTranscriptionConfig);
const mockCreate = vi.mocked(createTranscript);
const mockUseUploadManager = vi.mocked(useUploadManager);

const CONFIG = {
  available: true,
  providerLabel: 'AssemblyAI',
  maxUploadBytes: 100_000_000,
  maxDurationMs: 7_200_000,
  acceptedExtensions: ['.m4a', '.mp3'],
  acceptedMimeTypes: ['audio/mp4', 'audio/mpeg'],
};

const startUpload = vi.fn();
const pauseUpload = vi.fn();
const resumeUpload = vi.fn();
const cancelUpload = vi.fn();

function managerWith(uploads: ManagedUpload[] = []) {
  mockUseUploadManager.mockReturnValue({
    uploads,
    activeUploads: uploads,
    sessions: [],
    sessionsLoading: false,
    keepScreenAwake: true,
    setKeepScreenAwake: vi.fn(),
    wakeLockSupported: true,
    wakeLockHeld: false,
    startUpload,
    pauseUpload,
    resumeUpload,
    cancelUpload,
    dismissUpload: vi.fn(),
    resumeFromSession: vi.fn(),
    refreshSessions: vi.fn(),
    getUpload: vi.fn(),
  } as unknown as ReturnType<typeof useUploadManager>);
}

function upload(overrides: Partial<ManagedUpload['progress']> = {}): ManagedUpload {
  return {
    id: 'obj-1',
    objectId: 'obj-1',
    transcriptId: 't1',
    fileName: 'standup.m4a',
    size: 1_000_000,
    startedAt: Date.now(),
    resumed: false,
    progress: {
      phase: 'uploading',
      uploadedBytes: 400_000,
      totalBytes: 1_000_000,
      percent: 40,
      completedParts: 2,
      totalParts: 5,
      bytesPerSecond: 1_400_000,
      etaSeconds: 120,
      error: null,
      waitingForNetwork: false,
      ...overrides,
    },
  };
}

const CREATED = {
  transcript: { id: 't1' },
  upload: {
    objectId: 'obj-1',
    uploadId: 'up-1',
    partSize: 8_388_608,
    totalParts: 1,
    presignedUrls: [{ partNumber: 1, url: 'https://storage.example/put' }],
  },
};

/** A file the picker will accept, with a real `size` the checks can read. */
function audioFile(name = 'standup.m4a', size = 1_000_000, type = 'audio/mp4'): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue(CONFIG);
  mockCreate.mockResolvedValue(CREATED as never);
  startUpload.mockResolvedValue(upload());
  managerWith([]);
});

describe('NewTranscriptPage — transcription not configured', () => {
  it('shows a disabled state rather than a form', async () => {
    mockGetConfig.mockResolvedValue({ ...CONFIG, available: false, providerLabel: null });
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });

    expect(await screen.findByText('Transcription is not set up yet')).toBeInTheDocument();
    expect(screen.queryByLabelText('Choose an audio file')).not.toBeInTheDocument();
  });

  it('offers the admin the settings page', async () => {
    mockGetConfig.mockResolvedValue({ ...CONFIG, available: false, providerLabel: null });
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(
      await screen.findByRole('button', { name: 'Open transcription settings' }),
    ).toBeInTheDocument();
  });

  it('does NOT offer it to someone who would be redirected straight back', async () => {
    // Gated on `system_settings:read` — the permission the transcription
    // settings controller actually enforces — rather than on the admin role.
    mockGetConfig.mockResolvedValue({ ...CONFIG, available: false, providerLabel: null });
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });

    await screen.findByText('Transcription is not set up yet');
    expect(
      screen.queryByRole('button', { name: 'Open transcription settings' }),
    ).not.toBeInTheDocument();
  });

  it('treats a FAILED config probe as not configured', async () => {
    // Every path out of this screen needs the ceilings the probe carries;
    // guessing at them would let a user start an upload the API will refuse.
    mockGetConfig.mockRejectedValue(new Error('offline'));
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });

    expect(await screen.findByText('Transcription is not set up yet')).toBeInTheDocument();
  });
});

describe('NewTranscriptPage — choosing a file', () => {
  it('accepts audio/* plus every extension the issue names', async () => {
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });
    const input = await screen.findByLabelText('Choose an audio file');

    const accept = input.getAttribute('accept') ?? '';
    expect(accept).toContain('audio/*');
    for (const extension of ['.m4a', '.mp3', '.wav', '.flac', '.ogg', '.opus', '.aac', '.amr', '.webm', '.wma']) {
      expect(accept).toContain(extension);
    }
  });

  it('rejects a file over the deployment’s size ceiling, before a byte moves', async () => {
    const user = userEvent.setup();
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });
    const input = await screen.findByLabelText('Choose an audio file');

    await user.upload(input, audioFile('huge.m4a', 250_000_000));

    expect(await screen.findByText(/limit is 100.0 MB/)).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a file that is not audio at all', async () => {
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });
    const input = (await screen.findByLabelText(
      'Choose an audio file',
    )) as HTMLInputElement;

    // `fireEvent.change` rather than `userEvent.upload`, because userEvent
    // enforces the input's own `accept` attribute and drops the file before
    // the change handler ever runs — which would make this a test of the
    // ATTRIBUTE rather than of the rule. A drag-and-drop has no such filter,
    // and neither does a picker on a platform whose MIME table disagrees with
    // ours, so the rule has to hold on its own.
    const file = audioFile('notes.pdf', 1000, 'application/pdf');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    expect(await screen.findByText(/does not look like an audio file/)).toBeInTheDocument();
  });

  it('prefills the title from the file name', async () => {
    const user = userEvent.setup();
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });
    const input = await screen.findByLabelText('Choose an audio file');

    await user.upload(input, audioFile('Weekly standup.m4a'));

    await waitFor(() =>
      expect(screen.getByLabelText('Title')).toHaveValue('Weekly standup'),
    );
  });

  it('names the provider in the privacy notice', async () => {
    // "Sent to a third party" is not consent — the user is entitled to know
    // WHICH one before they upload (spec §10).
    const user = userEvent.setup();
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });
    const input = await screen.findByLabelText('Choose an audio file');

    await user.upload(input, audioFile());

    expect(await screen.findByText('AssemblyAI')).toBeInTheDocument();
  });
});

describe('NewTranscriptPage — starting the upload', () => {
  it('creates the transcript and hands the manager the upload the API made', async () => {
    // NOT a second `POST /storage/objects/upload/init`: the object the API
    // created is `managed_by: 'transcripts'`, which a client cannot ask for,
    // so a second init would leave an orphan for housekeeping to fail on.
    const user = userEvent.setup();
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });
    await user.upload(await screen.findByLabelText('Choose an audio file'), audioFile());

    await user.click(await screen.findByRole('button', { name: 'Start upload' }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'standup',
        language: null,
        speakersExpected: null,
        source: expect.objectContaining({ name: 'standup.m4a', size: 1_000_000 }),
      }),
    );
    expect(startUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptId: 't1',
        init: expect.objectContaining({
          objectId: 'obj-1',
          uploadId: 'up-1',
          parts: CREATED.upload.presignedUrls,
        }),
      }),
    );
  });

  it('sends the chosen language and speaker count', async () => {
    const user = userEvent.setup();
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });
    await user.upload(await screen.findByLabelText('Choose an audio file'), audioFile());

    await user.click(await screen.findByLabelText('Language'));
    await user.click(await screen.findByRole('option', { name: 'Spanish' }));
    await user.click(screen.getByLabelText('Expected speakers'));
    await user.click(await screen.findByRole('option', { name: '3' }));
    await user.click(screen.getByRole('button', { name: 'Start upload' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'es', speakersExpected: 3 }),
      ),
    );
  });

  it('says plainly when the DEPLOYMENT refuses, not "check your file"', async () => {
    // 409 means transcription is not configured. Blaming the file would send
    // the user off to fix something that is not broken.
    const user = userEvent.setup();
    mockCreate.mockRejectedValue(new ApiError('not configured', 409));
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });
    await user.upload(await screen.findByLabelText('Choose an audio file'), audioFile());

    await user.click(await screen.findByRole('button', { name: 'Start upload' }));

    await waitFor(() =>
      expect(screen.getByText(/not configured for this deployment/i)).toBeInTheDocument(),
    );
  });
});

describe('NewTranscriptPage — watching the upload', () => {
  it('shows progress, speed and an ETA read from the MANAGER, not from local state', async () => {
    const user = userEvent.setup();
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });
    await user.upload(await screen.findByLabelText('Choose an audio file'), audioFile());

    managerWith([upload()]);
    await user.click(await screen.findByRole('button', { name: 'Start upload' }));

    expect(await screen.findByText(/40% · 1.4 MB\/s · about 2 min left/)).toBeInTheDocument();
    expect(screen.getByLabelText('Upload progress')).toBeInTheDocument();
  });

  it('offers pause, and resume once paused', async () => {
    const user = userEvent.setup();
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });
    await user.upload(await screen.findByLabelText('Choose an audio file'), audioFile());

    managerWith([upload()]);
    await user.click(await screen.findByRole('button', { name: 'Start upload' }));
    await user.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(pauseUpload).toHaveBeenCalledWith('obj-1');

    managerWith([upload({ phase: 'paused' })]);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(cancelUpload).toHaveBeenCalledWith('obj-1');
  });

  it('says "waiting for the network" rather than a stalled ETA', async () => {
    // The engine pauses ITSELF when the browser goes offline, which is a
    // different state from a user's pause: offering a Resume button there
    // would offer a control that does nothing.
    const user = userEvent.setup();
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });
    await user.upload(await screen.findByLabelText('Choose an audio file'), audioFile());

    managerWith([upload({ waitingForNetwork: true })]);
    await user.click(await screen.findByRole('button', { name: 'Start upload' }));

    expect(await screen.findByText(/Waiting for the network/)).toBeInTheDocument();
  });

  it('tells the user the upload survives leaving the page', async () => {
    const user = userEvent.setup();
    render(<NewTranscriptPage />, { wrapperOptions: { user: mockUser } });
    await user.upload(await screen.findByLabelText('Choose an audio file'), audioFile());

    managerWith([upload()]);
    await user.click(await screen.findByRole('button', { name: 'Start upload' }));

    expect(await screen.findByText(/You can leave this page/)).toBeInTheDocument();
  });

  it('navigates to the transcript when the upload COMPLETES', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<NewTranscriptPage />, {
      wrapperOptions: { user: mockUser },
    });
    await user.upload(await screen.findByLabelText('Choose an audio file'), audioFile());

    managerWith([upload()]);
    await user.click(await screen.findByRole('button', { name: 'Start upload' }));
    await screen.findByLabelText('Upload progress');

    // Completion is observed through the MANAGER's progress rather than by
    // awaiting the transfer: the user may have left and come back, and the
    // promise this page was awaiting would have gone with the unmount.
    managerWith([upload({ phase: 'completed', percent: 100 })]);
    rerender(<NewTranscriptPage />);

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/transcripts/t1', { replace: true }),
    );
  });
});

describe('NewTranscriptPage — accessibility', () => {
  it('has no axe violations on the file step', async () => {
    const { container } = render(<NewTranscriptPage />, {
      wrapperOptions: { user: mockUser },
    });
    await screen.findByLabelText('Choose an audio file');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations on the details step', async () => {
    const user = userEvent.setup();
    const { container } = render(<NewTranscriptPage />, {
      wrapperOptions: { user: mockUser },
    });
    await user.upload(await screen.findByLabelText('Choose an audio file'), audioFile());
    await screen.findByRole('button', { name: 'Start upload' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations in the not-configured state', async () => {
    mockGetConfig.mockResolvedValue({ ...CONFIG, available: false, providerLabel: null });
    const { container } = render(<NewTranscriptPage />, {
      wrapperOptions: { user: mockAdminUser },
    });
    await screen.findByText('Transcription is not set up yet');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
