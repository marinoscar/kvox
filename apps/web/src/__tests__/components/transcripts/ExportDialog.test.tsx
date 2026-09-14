/**
 * The transcript export dialog (issue #28, epic #19).
 *
 * What is under test is not "does the form hold state" — it is the four claims
 * the dialog makes that nothing else in the app can make for it:
 *
 *   * THE FORM IS BUILT FROM THE SERVER'S ANSWER. A format the API publishes
 *     appears with ITS OWN options and no client-side knowledge of what
 *     "markdown" means. The test for this deliberately includes a format that
 *     does not exist in the API today, because a dialog that only worked for
 *     the three shipped formats would pass a test using only those three and
 *     still break the promise the registry exists to keep.
 *   * IT POLLS UNTIL THE EXPORT SETTLES, and stops for both outcomes — ready
 *     and failed — rather than only for the happy one.
 *   * A REUSED EXPORT SKIPS THE POLL ENTIRELY. `POST` answering 200 with a
 *     `ready` row is the common case for a second download, and asking again
 *     for something already finished would be a wasted round trip and a
 *     spinner nobody needed to see.
 *   * IT IS FULL SCREEN ON PHONES, at `down('sm')` and not at `down('md')` —
 *     one of the five coupled breakpoint gates CLAUDE.md's rule 5 names, so
 *     the boundary itself is asserted rather than just "it is full screen
 *     somewhere narrow".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { resetViewportWidth, setViewportWidth } from '../../setup';
import { ExportDialog, versionChoices } from '../../../components/transcripts/ExportDialog';
import type {
  TranscriptExport,
  TranscriptExporter,
  TranscriptVersionOption,
} from '../../../services/transcriptExports';

vi.mock('../../../services/transcriptExports', async () => {
  const actual = await vi.importActual<typeof import('../../../services/transcriptExports')>(
    '../../../services/transcriptExports',
  );

  return {
    ...actual,
    // The poll interval is shortened so the tests do not spend real seconds
    // waiting; everything else — the helpers, the constants' meaning — is the
    // real module, so a change to `isSettled` or `defaultOptionsFor` is caught
    // here rather than mocked away.
    EXPORT_POLL_INTERVAL_MS: 1,
    getExporters: vi.fn(),
    getExport: vi.fn(),
    createExport: vi.fn(),
    getExportableVersions: vi.fn(),
  };
});

import {
  createExport,
  getExport,
  getExportableVersions,
  getExporters,
} from '../../../services/transcriptExports';

const mockGetExporters = vi.mocked(getExporters);
const mockGetExport = vi.mocked(getExport);
const mockCreateExport = vi.mocked(createExport);
const mockGetVersions = vi.mocked(getExportableVersions);

const TRANSCRIPT_ID = 'tr-1';

const EXPORTERS: TranscriptExporter[] = [
  {
    format: 'json',
    label: 'JSON',
    mimeType: 'application/json',
    extension: 'json',
    options: [
      {
        key: 'includeWords',
        label: 'Include word timings',
        description: 'Much larger, and only useful to something aligning text to audio.',
        type: 'boolean',
        default: false,
      },
    ],
  },
  {
    format: 'markdown',
    label: 'Markdown',
    mimeType: 'text/markdown; charset=utf-8',
    extension: 'md',
    options: [
      {
        key: 'includeTimestamps',
        label: 'Include timestamps',
        description: 'Puts the media position beside each speaker turn.',
        type: 'boolean',
        default: true,
      },
      {
        key: 'mergeConsecutive',
        label: 'Merge consecutive turns',
        description: 'Joins neighbouring segments from the same speaker.',
        type: 'boolean',
        default: false,
      },
    ],
  },
];

const VERSIONS: TranscriptVersionOption[] = [
  {
    version: 3,
    kind: 'edit',
    summary: 'Renamed a speaker',
    author: { id: 'u1', name: 'Oscar Marin', email: 'oscar@example.test' },
    createdAt: '2026-09-12T09:00:00.000Z',
  },
  {
    version: 1,
    kind: 'ai_original',
    summary: 'Transcribed by AssemblyAI',
    author: null,
    createdAt: '2026-09-10T15:04:22.000Z',
  },
];

function exportRow(overrides: Partial<TranscriptExport> = {}): TranscriptExport {
  return {
    id: 'exp-1',
    transcriptId: TRANSCRIPT_ID,
    version: 3,
    format: 'markdown',
    options: {},
    status: 'pending',
    reused: false,
    mimeType: 'text/markdown; charset=utf-8',
    filename: 'Weekly sync (v3).md',
    sizeBytes: null,
    error: null,
    downloadUrl: null,
    downloadExpiresAt: null,
    expiresAt: '2026-09-21T00:00:00.000Z',
    createdAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  };
}

const readyRow = (overrides: Partial<TranscriptExport> = {}) =>
  exportRow({
    status: 'ready',
    sizeBytes: '4096',
    downloadUrl: 'https://storage.example/signed',
    downloadExpiresAt: '2026-09-14T00:15:00.000Z',
    ...overrides,
  });

const onClose = vi.fn();

function renderDialog(overrides: { open?: boolean; currentVersion?: number } = {}) {
  return render(
    <ExportDialog
      open={overrides.open ?? true}
      onClose={onClose}
      transcriptId={TRANSCRIPT_ID}
      currentVersion={overrides.currentVersion ?? 3}
    />,
  );
}

/** Wait for the formats to have loaded and the form to be usable. */
async function ready() {
  await waitFor(() => {
    expect(screen.getByRole('radio', { name: 'Markdown' })).toBeInTheDocument();
  });
}

const exportButton = () => screen.getByRole('button', { name: /^export$|^exporting/i });

/**
 * A promise the test resolves by hand.
 *
 * The poll interval is 1 ms in this file, so a mocked `getExport` that resolves
 * immediately finishes the whole loop before React has painted the working
 * state — and a test asserting "the spinner is shown while it runs" would be
 * asserting against a frame that never existed. Holding the first poll open is
 * what makes the in-flight state observable at all.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

describe('ExportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExporters.mockResolvedValue(EXPORTERS);
    mockGetVersions.mockResolvedValue(VERSIONS);
    mockCreateExport.mockResolvedValue(exportRow());
    mockGetExport.mockResolvedValue(readyRow());
  });

  afterEach(() => {
    resetViewportWidth();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Format and options, built from the server's answer
  // =========================================================================

  describe('format and options', () => {
    it('offers every format the API published, and selects the first', async () => {
      renderDialog();
      await ready();

      expect(screen.getByRole('radio', { name: 'JSON' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Markdown' })).not.toBeChecked();
    });

    it('renders the SELECTED format\'s own options, with their defaults', async () => {
      const user = userEvent.setup();

      renderDialog();
      await ready();

      // JSON's one option, off by default.
      expect(screen.getByRole('checkbox', { name: 'Include word timings' })).not.toBeChecked();
      expect(screen.queryByRole('checkbox', { name: 'Include timestamps' })).toBeNull();

      await user.click(screen.getByRole('radio', { name: 'Markdown' }));

      // Markdown's two, with ITS defaults — one on, one off.
      expect(screen.getByRole('checkbox', { name: 'Include timestamps' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Merge consecutive turns' })).not.toBeChecked();
      expect(screen.queryByRole('checkbox', { name: 'Include word timings' })).toBeNull();
    });

    it('shows each option\'s description, so a checkbox is not a guess', async () => {
      renderDialog();
      await ready();

      expect(screen.getByText(/only useful to something aligning text to audio/i)).toBeInTheDocument();
    });

    it('renders a format it has never heard of, with that format\'s options', async () => {
      // The registry's whole promise: a new exporter is one new class on the
      // server and NOTHING in apps/web. A dialog that knew the three shipped
      // formats would pass every other test in this file and still break this.
      mockGetExporters.mockResolvedValue([
        {
          format: 'docx',
          label: 'Word document',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          extension: 'docx',
          options: [
            {
              key: 'trackChanges',
              label: 'Mark AI text as a suggestion',
              description: 'Uses Word revision marks for anything nobody has confirmed.',
              type: 'boolean',
              default: true,
            },
          ],
        },
      ]);

      renderDialog();

      await waitFor(() => {
        expect(screen.getByRole('radio', { name: 'Word document' })).toBeChecked();
      });

      expect(screen.getByRole('checkbox', { name: 'Mark AI text as a suggestion' })).toBeChecked();
    });

    it('sends the chosen format, version and options', async () => {
      const user = userEvent.setup();

      renderDialog();
      await ready();

      await user.click(screen.getByRole('radio', { name: 'Markdown' }));
      await user.click(screen.getByRole('checkbox', { name: 'Merge consecutive turns' }));
      await user.click(exportButton());

      await waitFor(() => {
        expect(mockCreateExport).toHaveBeenCalledWith(TRANSCRIPT_ID, {
          format: 'markdown',
          version: 3,
          options: { includeTimestamps: true, mergeConsecutive: true },
        });
      });
    });
  });

  // =========================================================================
  // Version
  // =========================================================================

  describe('version', () => {
    it('defaults to the current version and labels it as current', async () => {
      renderDialog();
      await ready();

      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: /version/i })).toHaveTextContent(
          /Current \(v3\)/,
        );
      });
    });

    it('offers every version in the history, naming the AI original', async () => {
      const user = userEvent.setup();

      renderDialog();
      await ready();

      await waitFor(() => expect(mockGetVersions).toHaveBeenCalled());

      await user.click(screen.getByRole('combobox', { name: /version/i }));

      const list = await screen.findByRole('listbox');

      expect(within(list).getByText(/Current \(v3\)/)).toBeInTheDocument();
      expect(within(list).getByText(/v1 — Transcribed by AssemblyAI/)).toBeInTheDocument();
    });

    it('exports the version that was chosen, not the current one', async () => {
      const user = userEvent.setup();

      renderDialog();
      await ready();
      await waitFor(() => expect(mockGetVersions).toHaveBeenCalled());

      await user.click(screen.getByRole('combobox', { name: /version/i }));
      await user.click(await screen.findByText(/v1 — Transcribed by AssemblyAI/));
      await user.click(exportButton());

      await waitFor(() => {
        expect(mockCreateExport).toHaveBeenCalledWith(
          TRANSCRIPT_ID,
          expect.objectContaining({ version: 1 }),
        );
      });
    });

    it('still offers the current version when the history will not load', async () => {
      // A version list that fails is not a reason to block the export: the
      // default — the current version — needs no history to be selectable.
      mockGetVersions.mockRejectedValue(new Error('nope'));

      renderDialog();
      await ready();

      expect(screen.getByRole('combobox', { name: /version/i })).toHaveTextContent(
        /Current \(v3\)/,
      );
      expect(exportButton()).toBeEnabled();
    });
  });

  // =========================================================================
  // Polling and download
  // =========================================================================

  describe('polling', () => {
    it('polls until the export is ready, then offers the download', async () => {
      const user = userEvent.setup();
      const firstPoll = deferred<TranscriptExport>();

      mockGetExport.mockReturnValueOnce(firstPoll.promise).mockResolvedValue(readyRow());

      renderDialog();
      await ready();
      await user.click(exportButton());

      expect(await screen.findByLabelText('Rendering the export')).toBeInTheDocument();

      // Still pending, so the dialog asks again rather than settling.
      firstPoll.resolve(exportRow());

      const download = await screen.findByRole('button', { name: /download/i });

      expect(mockGetExport).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('export-ready')).toHaveTextContent('Weekly sync (v3).md');
      expect(screen.getByTestId('export-ready')).toHaveTextContent('4.0 KB');
      expect(download).toBeEnabled();
    });

    it('does NOT poll when the API returned an export that already existed', async () => {
      const user = userEvent.setup();

      mockCreateExport.mockResolvedValue(readyRow({ reused: true }));

      renderDialog();
      await ready();
      await user.click(exportButton());

      expect(await screen.findByRole('button', { name: /download/i })).toBeInTheDocument();
      expect(mockGetExport).not.toHaveBeenCalled();
    });

    it('opens the signed URL rather than fetching the bytes', async () => {
      const user = userEvent.setup();
      const open = vi.spyOn(window, 'open').mockReturnValue(null);

      mockCreateExport.mockResolvedValue(readyRow({ reused: true }));

      renderDialog();
      await ready();
      await user.click(exportButton());
      await user.click(await screen.findByRole('button', { name: /download/i }));

      expect(open).toHaveBeenCalledWith(
        'https://storage.example/signed',
        '_blank',
        'noopener,noreferrer',
      );
    });

    it('disables Close and Export while the render is running', async () => {
      const user = userEvent.setup();
      const firstPoll = deferred<TranscriptExport>();

      mockGetExport.mockReturnValueOnce(firstPoll.promise).mockResolvedValue(readyRow());

      renderDialog();
      await ready();
      await user.click(exportButton());

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /exporting/i })).toBeDisabled();
      });
      // Closing mid-render would leave the user with no way back to an export
      // that is still being made — and nothing client-side can cancel it.
      expect(screen.getByRole('button', { name: /close/i })).toBeDisabled();

      firstPoll.resolve(readyRow());

      await screen.findByRole('button', { name: /download/i });
    });
  });

  // =========================================================================
  // Errors
  // =========================================================================

  describe('errors', () => {
    it('shows the API\'s own reason when the request is refused', async () => {
      const user = userEvent.setup();

      mockCreateExport.mockRejectedValue(new Error('Unknown export format "docx".'));

      renderDialog();
      await ready();
      await user.click(exportButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('Unknown export format "docx".');
      expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
    });

    it('stops polling and shows the reason when the RENDER fails', async () => {
      const user = userEvent.setup();

      mockGetExport.mockResolvedValue(
        exportRow({ status: 'failed', error: 'The snapshot is missing from storage.' }),
      );

      renderDialog();
      await ready();
      await user.click(exportButton());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The snapshot is missing from storage.',
      );
      expect(mockGetExport).toHaveBeenCalledTimes(1);
    });

    it('reports a formats list that will not load, and offers no export', async () => {
      mockGetExporters.mockRejectedValue(new Error('offline'));

      renderDialog();

      expect(await screen.findByRole('alert')).toHaveTextContent('offline');
      await waitFor(() => expect(exportButton()).toBeDisabled());
    });

    it('re-enables Export after a failure, so a retry is possible', async () => {
      const user = userEvent.setup();

      mockCreateExport.mockRejectedValue(new Error('the storage provider is unavailable'));

      renderDialog();
      await ready();
      await user.click(exportButton());

      await screen.findByRole('alert');

      expect(exportButton()).toBeEnabled();
    });
  });

  // =========================================================================
  // Phone layout
  // =========================================================================

  describe('the compact window', () => {
    it('is full screen at 599px', async () => {
      act(() => setViewportWidth(599));

      renderDialog();
      await ready();

      expect(screen.getByRole('dialog')).toHaveClass('MuiDialog-paperFullScreen');
    });

    it('is NOT full screen at 600px — the gate is `sm`, never `md`', async () => {
      // Gating at 900px would hand the phone treatment to tablets, foldables
      // and landscape phones. One of CLAUDE.md rule 5's five coupled gates.
      act(() => setViewportWidth(600));

      renderDialog();
      await ready();

      expect(screen.getByRole('dialog')).not.toHaveClass('MuiDialog-paperFullScreen');
    });

    it('is not full screen on a desktop width', async () => {
      act(() => setViewportWidth(1440));

      renderDialog();
      await ready();

      expect(screen.getByRole('dialog')).not.toHaveClass('MuiDialog-paperFullScreen');
    });
  });
});

describe('versionChoices', () => {
  it('falls back to the current version alone when there is no history', () => {
    expect(versionChoices([], 4)).toEqual([{ version: 4, label: 'Current (v4)' }]);
  });

  it('orders newest first whatever order the API returned', () => {
    expect(versionChoices([...VERSIONS].reverse(), 3).map((choice) => choice.version)).toEqual([
      3, 1,
    ]);
  });

  it('marks the current version, and only it', () => {
    const labels = versionChoices(VERSIONS, 3).map((choice) => choice.label);

    expect(labels[0]).toMatch(/^Current \(v3\)/);
    expect(labels[1]).toMatch(/^v1 —/);
  });
});
