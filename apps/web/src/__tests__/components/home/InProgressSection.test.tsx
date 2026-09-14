import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../../hooks/useUploadManager', () => ({ useUploadManager: vi.fn() }));

import { render } from '../../utils/test-utils';
import { useUploadManager } from '../../../hooks/useUploadManager';
import {
  InProgressSection,
  dedupeServerItems,
} from '../../../components/home/InProgressSection';
import { UploadSessionMismatchError } from '../../../services/uploadSessions';
import { AXE_OPTIONS, manager, session, transcript, upload } from './homeFixtures';

/**
 * The one section on the home page that reads two sources of truth at once —
 * the app-wide upload manager (this tab only) and the server's `inProgress`
 * list — so most of what is asserted here is the SEAM between them rather than
 * either half on its own.
 */

const mockUseUploadManager = vi.mocked(useUploadManager);

beforeEach(() => {
  mockNavigate.mockClear();
  mockUseUploadManager.mockReturnValue(manager());
});

describe('dedupeServerItems', () => {
  it('drops a server row a live upload is already showing', () => {
    const result = dedupeServerItems(
      [transcript({ id: 't-upload', status: 'uploading' })],
      [upload({ transcriptId: 't-upload' })],
    );

    expect(result).toEqual([]);
  });

  it('keeps a server row no local upload names', () => {
    const items = [transcript({ id: 't-other', status: 'processing' })];

    expect(dedupeServerItems(items, [upload({ transcriptId: 't-upload' })])).toEqual(items);
  });

  it('ignores an upload with no transcript attached yet', () => {
    const items = [transcript({ id: 't-other' })];

    expect(dedupeServerItems(items, [upload({ transcriptId: null })])).toEqual(items);
  });

  it('is a no-op with no uploads at all', () => {
    const items = [transcript(), transcript({ id: 't2' })];

    expect(dedupeServerItems(items, [])).toEqual(items);
  });
});

describe('InProgressSection — when there is nothing in flight', () => {
  it('renders nothing at all', () => {
    const { container } = render(<InProgressSection items={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when only SETTLED uploads remain', () => {
    // A completed upload belongs in Recent, not here; leaving it would make the
    // section permanent for the rest of the session.
    mockUseUploadManager.mockReturnValue(
      manager({ uploads: [upload({ progress: { phase: 'completed', percent: 100 } })] }),
    );

    const { container } = render(<InProgressSection items={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a cancelled upload', () => {
    mockUseUploadManager.mockReturnValue(
      manager({ uploads: [upload({ progress: { phase: 'cancelled' } })] }),
    );

    const { container } = render(<InProgressSection items={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('InProgressSection — a local upload', () => {
  beforeEach(() => {
    mockUseUploadManager.mockReturnValue(manager({ uploads: [upload()] }));
  });

  it('names the file being uploaded', () => {
    render(<InProgressSection items={[]} />);

    expect(screen.getByRole('heading', { name: 'interview.m4a' })).toBeInTheDocument();
  });

  it('shows the section heading once there is something to show', () => {
    render(<InProgressSection items={[]} />);

    expect(screen.getByRole('heading', { name: 'In progress' })).toBeInTheDocument();
  });

  it('reports bytes transferred rather than a bare percentage', () => {
    render(<InProgressSection items={[]} />);

    expect(screen.getByText(/Uploading · 10 MB of 40 MB/)).toBeInTheDocument();
  });

  it('offers a Pause control while it is moving', () => {
    render(<InProgressSection items={[]} />);

    expect(
      screen.getByRole('button', { name: 'Pause uploading interview.m4a' }),
    ).toBeEnabled();
  });

  it('pauses through the manager', async () => {
    const pauseUpload = vi.fn();
    mockUseUploadManager.mockReturnValue(manager({ uploads: [upload()], pauseUpload }));
    const user = userEvent.setup();
    render(<InProgressSection items={[]} />);

    await user.click(screen.getByRole('button', { name: 'Pause uploading interview.m4a' }));

    expect(pauseUpload).toHaveBeenCalledWith('obj-1');
  });

  it('offers a Resume control once paused', () => {
    mockUseUploadManager.mockReturnValue(
      manager({ uploads: [upload({ progress: { phase: 'paused' } })] }),
    );
    render(<InProgressSection items={[]} />);

    expect(
      screen.getByRole('button', { name: 'Resume uploading interview.m4a' }),
    ).toBeInTheDocument();
  });

  it('resumes through the manager', async () => {
    const resumeUpload = vi.fn();
    mockUseUploadManager.mockReturnValue(
      manager({ uploads: [upload({ progress: { phase: 'paused' } })], resumeUpload }),
    );
    const user = userEvent.setup();
    render(<InProgressSection items={[]} />);

    await user.click(screen.getByRole('button', { name: 'Resume uploading interview.m4a' }));

    expect(resumeUpload).toHaveBeenCalledWith('obj-1');
  });

  it('says "Paused" rather than "Uploading" when paused', () => {
    mockUseUploadManager.mockReturnValue(
      manager({ uploads: [upload({ progress: { phase: 'paused' } })] }),
    );
    render(<InProgressSection items={[]} />);

    expect(screen.getByText(/^Paused · /)).toBeInTheDocument();
  });

  it('cancels through the manager', async () => {
    const cancelUpload = vi.fn().mockResolvedValue(undefined);
    mockUseUploadManager.mockReturnValue(manager({ uploads: [upload()], cancelUpload }));
    const user = userEvent.setup();
    render(<InProgressSection items={[]} />);

    await user.click(screen.getByRole('button', { name: 'Cancel uploading interview.m4a' }));

    expect(cancelUpload).toHaveBeenCalledWith('obj-1');
  });

  it('says it is waiting for the network rather than offering a dead Resume', () => {
    // `waitingForNetwork` is the engine pausing ITSELF; a Resume button there
    // would do nothing at all.
    mockUseUploadManager.mockReturnValue(
      manager({
        uploads: [upload({ progress: { phase: 'paused', waitingForNetwork: true } })],
      }),
    );
    render(<InProgressSection items={[]} />);

    expect(screen.getByText(/Waiting for the network/)).toBeInTheDocument();
  });

  it('surfaces the engine error on a failed upload', () => {
    mockUseUploadManager.mockReturnValue(
      manager({
        uploads: [upload({ progress: { phase: 'failed', error: 'The connection dropped' } })],
      }),
    );
    render(<InProgressSection items={[]} />);

    expect(screen.getByText(/The connection dropped/)).toBeInTheDocument();
  });

  it('opens the transcript the upload belongs to', async () => {
    const user = userEvent.setup();
    render(<InProgressSection items={[]} />);

    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/t-upload');
  });

  it('offers no Open link for an upload with no transcript yet', () => {
    mockUseUploadManager.mockReturnValue(
      manager({ uploads: [upload({ transcriptId: null })] }),
    );
    render(<InProgressSection items={[]} />);

    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
  });
});

describe('InProgressSection — an interrupted session', () => {
  beforeEach(() => {
    mockUseUploadManager.mockReturnValue(manager({ sessions: [session()] }));
  });

  it('prompts to resume it', () => {
    render(<InProgressSection items={[]} />);

    expect(screen.getByRole('button', { name: 'Resume upload' })).toBeInTheDocument();
  });

  it('names the file that was interrupted', () => {
    render(<InProgressSection items={[]} />);

    expect(screen.getByRole('heading', { name: 'board-meeting.m4a' })).toBeInTheDocument();
  });

  it('explains that the same file has to be chosen again', () => {
    // A browser cannot hold a `File` across a reload — this is the one thing a
    // user has to understand about the prompt.
    render(<InProgressSection items={[]} />);

    expect(screen.getByText(/choose the same file to continue/i)).toBeInTheDocument();
  });

  it('hands the re-picked file to the manager', async () => {
    const resumeFromSession = vi.fn().mockResolvedValue(upload());
    mockUseUploadManager.mockReturnValue(
      manager({ sessions: [session()], resumeFromSession }),
    );
    const user = userEvent.setup();
    render(<InProgressSection items={[]} />);

    const file = new File(['x'], 'board-meeting.m4a', { type: 'audio/mp4' });
    await user.upload(
      screen.getByLabelText('Choose board-meeting.m4a again to resume'),
      file,
    );

    await waitFor(() => expect(resumeFromSession).toHaveBeenCalled());
    expect(resumeFromSession.mock.calls[0][1]).toBe(file);
  });

  it('reports a mismatched file instead of uploading it into the wrong object', async () => {
    const wrong = new File(['x'], 'other.m4a', { type: 'audio/mp4' });
    const resumeFromSession = vi
      .fn()
      .mockRejectedValue(new UploadSessionMismatchError(session(), wrong));
    mockUseUploadManager.mockReturnValue(
      manager({ sessions: [session()], resumeFromSession }),
    );
    const user = userEvent.setup();
    render(<InProgressSection items={[]} />);

    await user.upload(
      screen.getByLabelText('Choose board-meeting.m4a again to resume'),
      wrong,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/does not match/i);
  });

  it('reports an unexpected failure in plain words', async () => {
    const resumeFromSession = vi.fn().mockRejectedValue(new Error('boom'));
    mockUseUploadManager.mockReturnValue(
      manager({ sessions: [session()], resumeFromSession }),
    );
    const user = userEvent.setup();
    render(<InProgressSection items={[]} />);

    await user.upload(
      screen.getByLabelText('Choose board-meeting.m4a again to resume'),
      new File(['x'], 'board-meeting.m4a'),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not be resumed/i,
    );
  });

  it('drops the prompt once that upload is running again in this tab', () => {
    // Otherwise the same recording shows a progress bar AND an invitation to
    // start it over, at the same time.
    mockUseUploadManager.mockReturnValue(
      manager({
        uploads: [upload({ objectId: 'obj-interrupted', id: 'obj-interrupted' })],
        sessions: [session()],
      }),
    );
    render(<InProgressSection items={[]} />);

    expect(screen.queryByRole('button', { name: 'Resume upload' })).not.toBeInTheDocument();
  });
});

describe('InProgressSection — server-side processing', () => {
  it('shows the pipeline stage rather than the word "Processing"', () => {
    render(
      <InProgressSection
        items={[
          transcript({
            id: 't-proc',
            title: 'Customer discovery',
            status: 'processing',
            transcriptionStatus: 'processing',
            playbackStatus: 'ready',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Transcribing')).toBeInTheDocument();
  });

  it('says "Preparing audio" while only the transcode is moving', () => {
    render(
      <InProgressSection
        items={[
          transcript({
            id: 't-proc',
            status: 'processing',
            transcriptionStatus: 'waiting_input',
            playbackStatus: 'processing',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Preparing audio')).toBeInTheDocument();
  });

  it('falls back to the status word when there is no more specific stage', () => {
    render(
      <InProgressSection
        items={[
          transcript({
            id: 't-proc',
            status: 'processing',
            transcriptionStatus: 'completed',
            playbackStatus: 'ready',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Processing')).toBeInTheDocument();
  });

  it('opens the transcript when the row is tapped', async () => {
    const user = userEvent.setup();
    render(
      <InProgressSection
        items={[transcript({ id: 't-proc', title: 'Customer discovery', status: 'processing' })]}
      />,
    );

    await user.click(screen.getByRole('heading', { name: 'Customer discovery' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/t-proc');
  });
});

describe('InProgressSection — both kinds at once', () => {
  function renderBoth() {
    mockUseUploadManager.mockReturnValue(manager({ uploads: [upload()] }));
    return render(
      <InProgressSection
        items={[
          transcript({
            id: 't-proc',
            title: 'Customer discovery',
            status: 'processing',
            transcriptionStatus: 'processing',
          }),
        ]}
      />,
    );
  }

  it('lists the local upload and the server item together', () => {
    renderBoth();

    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows the upload with its byte counter', () => {
    renderBoth();

    expect(screen.getByText(/Uploading · 10 MB of 40 MB/)).toBeInTheDocument();
  });

  it('shows the server item with its stage chip', () => {
    renderBoth();

    expect(screen.getByText('Transcribing')).toBeInTheDocument();
  });

  it('puts the local upload first, because it is the one the user can act on', () => {
    renderBoth();

    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings[0]).toHaveTextContent('interview.m4a');
  });

  it('has no accessibility violations', async () => {
    const { container } = renderBoth();

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
