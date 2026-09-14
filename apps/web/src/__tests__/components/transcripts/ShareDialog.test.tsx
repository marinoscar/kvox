/**
 * `ShareDialog` (issue #29, epic #19).
 *
 * The service module is mocked; what is under test is the DIALOG'S OWN
 * behaviour — what it loads, what it sends, what it does with the four answers
 * the API can give it, and the two things it must never do: query as somebody
 * types, and reword a 404 or a 429.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';

vi.mock('../../../services/transcriptShares', async () => {
  const actual = await vi.importActual<
    typeof import('../../../services/transcriptShares')
  >('../../../services/transcriptShares');

  return {
    ...actual,
    getShares: vi.fn(),
    addShare: vi.fn(),
    updateShareRole: vi.fn(),
    removeShare: vi.fn(),
  };
});

// `services/api` is NOT mocked: the dialog distinguishes an `ApiError` from
// any other throw, so the tests below must construct the real class.
import { ApiError } from '../../../services/api';
import {
  addShare,
  getShares,
  removeShare,
  updateShareRole,
  type TranscriptShare,
} from '../../../services/transcriptShares';
import { ShareDialog } from '../../../components/transcripts/ShareDialog';

const mockGetShares = vi.mocked(getShares);
const mockAddShare = vi.mocked(addShare);
const mockUpdateShareRole = vi.mocked(updateShareRole);
const mockRemoveShare = vi.mocked(removeShare);

const share = (overrides: Partial<TranscriptShare> = {}): TranscriptShare => ({
  id: 'share-1',
  userId: 'user-2',
  email: 'colleague@example.test',
  displayName: 'A Colleague',
  role: 'viewer',
  grantedById: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

function renderDialog(props: Partial<React.ComponentProps<typeof ShareDialog>> = {}) {
  const onClose = vi.fn();
  const onSharesChanged = vi.fn();

  render(
    <ShareDialog
      open
      transcriptId="t-1"
      transcriptTitle="Board meeting"
      onClose={onClose}
      onSharesChanged={onSharesChanged}
      {...props}
    />,
  );

  return { onClose, onSharesChanged };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetShares.mockResolvedValue([]);
});

describe('ShareDialog', () => {
  describe('rendering', () => {
    it('names the transcript in its title', async () => {
      renderDialog();

      expect(
        await screen.findByRole('dialog', { name: /share .*board meeting/i }),
      ).toBeInTheDocument();
    });

    it('does not render, or load anything, when closed', () => {
      renderDialog({ open: false });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockGetShares).not.toHaveBeenCalled();
    });

    it('states plainly that the audio AND the transcript become visible', async () => {
      renderDialog();

      // Required copy, not decoration: this is the moment a private
      // conversation stops being private to one person.
      const note = await screen.findByText(/play the original audio and read the full/i);

      expect(note).toBeInTheDocument();
      expect(note.textContent).toMatch(/only you can delete it/i);
    });

    it('says so when nothing is shared yet', async () => {
      renderDialog();

      expect(await screen.findByText(/not shared with anyone yet/i)).toBeInTheDocument();
    });

    it('lists the current shares with their roles', async () => {
      mockGetShares.mockResolvedValue([
        share(),
        share({ id: 'share-2', userId: 'user-3', email: 'other@example.test', displayName: null, role: 'editor' }),
      ]);

      renderDialog();

      expect(await screen.findByText('A Colleague')).toBeInTheDocument();
      // No display name: the address IS the label, not a blank row.
      expect(screen.getByText('other@example.test')).toBeInTheDocument();
      expect(screen.getByLabelText('Role for A Colleague')).toHaveValue('viewer');
      expect(screen.getByLabelText('Role for other@example.test')).toHaveValue('editor');
    });

    it('reports a failure to load the list', async () => {
      mockGetShares.mockRejectedValue(new ApiError('Transcript not found', 404));

      renderDialog();

      expect(await screen.findByText('Transcript not found')).toBeInTheDocument();
    });
  });

  describe('adding somebody', () => {
    it('sends the typed address and the chosen role, once, on submit', async () => {
      const user = userEvent.setup();

      mockAddShare.mockResolvedValue(share({ role: 'editor' }));

      const { onSharesChanged } = renderDialog();

      await screen.findByLabelText('Email address');
      await user.type(screen.getByLabelText('Email address'), 'colleague@example.test');
      await user.selectOptions(screen.getByLabelText('Role'), 'editor');
      await user.click(screen.getByRole('button', { name: 'Share' }));

      await waitFor(() => {
        expect(mockAddShare).toHaveBeenCalledWith('t-1', {
          email: 'colleague@example.test',
          role: 'editor',
        });
      });
      expect(mockAddShare).toHaveBeenCalledTimes(1);
      expect(onSharesChanged).toHaveBeenCalledWith([share({ role: 'editor' })]);
    });

    it('NEVER queries while the address is being typed', async () => {
      const user = userEvent.setup();

      renderDialog();

      await screen.findByLabelText('Email address');
      await user.type(screen.getByLabelText('Email address'), 'colleague@example.test');

      // A type-ahead here would be the user-directory enumerator issue #29
      // rejected, rebuilt on the client — and it would burn the server's
      // per-caller rate limit doing it.
      expect(mockAddShare).not.toHaveBeenCalled();
      expect(mockGetShares).toHaveBeenCalledTimes(1);
    });

    it('shows the server\'s OWN generic message for an unknown address, unaltered', async () => {
      const user = userEvent.setup();

      mockAddShare.mockRejectedValue(new ApiError('No user with that email', 404));

      renderDialog();

      await screen.findByLabelText('Email address');
      await user.type(screen.getByLabelText('Email address'), 'nobody@example.test');
      await user.click(screen.getByRole('button', { name: 'Share' }));

      const error = await screen.findByText('No user with that email');

      expect(error).toBeInTheDocument();
      // No "did you mean", no "that account is deactivated", and above all no
      // echo of the address — the generic answer is the feature.
      expect(error.textContent).not.toContain('nobody@example.test');
    });

    it('shows the rate-limit message as the server sends it', async () => {
      const user = userEvent.setup();

      mockAddShare.mockRejectedValue(
        new ApiError(
          'Too many share attempts for addresses with no account. Please wait a few minutes and try again.',
          429,
        ),
      );

      renderDialog();

      await screen.findByLabelText('Email address');
      await user.type(screen.getByLabelText('Email address'), 'probe@example.test');
      await user.click(screen.getByRole('button', { name: 'Share' }));

      expect(await screen.findByText(/too many share attempts/i)).toBeInTheDocument();
    });

    it('refuses an empty address without calling the API', async () => {
      const user = userEvent.setup();

      renderDialog();

      await screen.findByLabelText('Email address');
      await user.click(screen.getByRole('button', { name: 'Share' }));

      expect(await screen.findByText(/enter the email address/i)).toBeInTheDocument();
      expect(mockAddShare).not.toHaveBeenCalled();
    });

    it('replaces rather than duplicates when re-sharing with somebody already listed', async () => {
      const user = userEvent.setup();

      mockGetShares.mockResolvedValue([share()]);
      mockAddShare.mockResolvedValue(share({ role: 'editor' }));

      renderDialog();

      await screen.findByText('A Colleague');
      await user.type(screen.getByLabelText('Email address'), 'colleague@example.test');
      await user.click(screen.getByRole('button', { name: 'Share' }));

      await waitFor(() => {
        expect(screen.getByLabelText('Role for A Colleague')).toHaveValue('editor');
      });
      // One row, not two: the API updates an existing share rather than
      // failing, so the list must not grow.
      expect(screen.getAllByText('A Colleague')).toHaveLength(1);
    });
  });

  describe('changing a role', () => {
    it('promotes a viewer to editor', async () => {
      const user = userEvent.setup();

      mockGetShares.mockResolvedValue([share()]);
      mockUpdateShareRole.mockResolvedValue(share({ role: 'editor' }));

      const { onSharesChanged } = renderDialog();

      await screen.findByText('A Colleague');
      await user.selectOptions(screen.getByLabelText('Role for A Colleague'), 'editor');

      await waitFor(() => {
        expect(mockUpdateShareRole).toHaveBeenCalledWith('t-1', 'user-2', 'editor');
      });
      expect(onSharesChanged).toHaveBeenCalledWith([share({ role: 'editor' })]);
    });

    it('reports a failed role change and leaves the row alone', async () => {
      const user = userEvent.setup();

      mockGetShares.mockResolvedValue([share()]);
      mockUpdateShareRole.mockRejectedValue(
        new ApiError('That transcript is not shared with this user', 404),
      );

      renderDialog();

      await screen.findByText('A Colleague');
      await user.selectOptions(screen.getByLabelText('Role for A Colleague'), 'editor');

      expect(
        await screen.findByText('That transcript is not shared with this user'),
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Role for A Colleague')).toHaveValue('viewer');
    });
  });

  describe('removing somebody', () => {
    it('removes the row and tells the parent', async () => {
      const user = userEvent.setup();

      mockGetShares.mockResolvedValue([share()]);
      mockRemoveShare.mockResolvedValue(undefined);

      const { onSharesChanged } = renderDialog();

      await screen.findByText('A Colleague');
      await user.click(screen.getByRole('button', { name: 'Remove A Colleague' }));

      await waitFor(() => {
        expect(mockRemoveShare).toHaveBeenCalledWith('t-1', 'user-2');
      });
      expect(await screen.findByText(/not shared with anyone yet/i)).toBeInTheDocument();
      expect(onSharesChanged).toHaveBeenCalledWith([]);
    });

    it('keeps the row when the removal fails, and says why', async () => {
      const user = userEvent.setup();

      mockGetShares.mockResolvedValue([share()]);
      mockRemoveShare.mockRejectedValue(new ApiError('Transcript not found', 404));

      renderDialog();

      await screen.findByText('A Colleague');
      await user.click(screen.getByRole('button', { name: 'Remove A Colleague' }));

      expect(await screen.findByText('Transcript not found')).toBeInTheDocument();
      expect(screen.getByText('A Colleague')).toBeInTheDocument();
    });
  });

  describe('lifecycle', () => {
    it('clears the typed address and the last error each time it opens', async () => {
      const user = userEvent.setup();

      mockAddShare.mockRejectedValue(new ApiError('No user with that email', 404));

      const { rerender } = render(
        <ShareDialog
          open
          transcriptId="t-1"
          transcriptTitle="Board meeting"
          onClose={vi.fn()}
        />,
      );

      await screen.findByLabelText('Email address');
      await user.type(screen.getByLabelText('Email address'), 'nobody@example.test');
      await user.click(screen.getByRole('button', { name: 'Share' }));
      await screen.findByText('No user with that email');

      rerender(
        <ShareDialog
          open={false}
          transcriptId="t-1"
          transcriptTitle="Board meeting"
          onClose={vi.fn()}
        />,
      );
      rerender(
        <ShareDialog
          open
          transcriptId="t-1"
          transcriptTitle="Board meeting"
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText('Email address')).toHaveValue('');
      });
      expect(screen.queryByText('No user with that email')).not.toBeInTheDocument();
    });

    it('reloads when it is pointed at a different transcript', async () => {
      const { rerender } = render(
        <ShareDialog open transcriptId="t-1" transcriptTitle="One" onClose={vi.fn()} />,
      );

      await waitFor(() => expect(mockGetShares).toHaveBeenCalledWith('t-1'));

      rerender(
        <ShareDialog open transcriptId="t-2" transcriptTitle="Two" onClose={vi.fn()} />,
      );

      await waitFor(() => expect(mockGetShares).toHaveBeenCalledWith('t-2'));
    });

    it('closes on Done', async () => {
      const user = userEvent.setup();
      const { onClose } = renderDialog();

      await user.click(await screen.findByRole('button', { name: 'Done' }));

      expect(onClose).toHaveBeenCalled();
    });
  });
});
