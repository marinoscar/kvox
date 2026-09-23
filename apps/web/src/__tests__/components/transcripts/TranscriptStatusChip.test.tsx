/**
 * `TranscriptStatusChip` — issue #322's "Upload interrupted" state.
 *
 * The server only knows a transcript is `uploading`; whether its bytes are
 * moving is known only to this browser's upload manager. These tests mount a
 * real `UploadManagerContext` value (no engine) and assert the seam: a live
 * upload keeps the spinner, no live upload says "Upload interrupted", and no
 * manager at all keeps today's rendering rather than guessing.
 */

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { render } from '../../utils/test-utils';
import { TranscriptStatusChip } from '../../../components/transcripts/TranscriptStatusChip';
import { UploadManagerContext } from '../../../contexts/UploadManagerContext';
import type { ManagedUpload } from '../../../contexts/UploadManagerContext';
import type { UploadPhase } from '../../../services/resumableUpload';
import { manager, upload } from '../home/homeFixtures';

const UPLOADING = {
  id: 't-upload',
  status: 'uploading' as const,
  transcriptionStatus: 'waiting_input' as const,
  playbackStatus: 'pending' as const,
};

function withUploads(uploads: ManagedUpload[], child: ReactNode) {
  return (
    <UploadManagerContext.Provider value={manager({ uploads })}>
      {child}
    </UploadManagerContext.Provider>
  );
}

function uploadIn(phase: UploadPhase, transcriptId = 't-upload') {
  return upload({ transcriptId, progress: { ...upload().progress, phase } });
}

describe('TranscriptStatusChip — uploading', () => {
  it.each<UploadPhase>(['uploading', 'paused', 'idle', 'completing'])(
    'keeps the spinner while this browser is live for it (%s)',
    (phase) => {
      render(withUploads([uploadIn(phase)], <TranscriptStatusChip transcript={UPLOADING} showStage />));

      expect(screen.getByText('Uploading · Preparing audio')).toBeInTheDocument();
      expect(screen.getByRole('progressbar', { hidden: true })).toBeInTheDocument();
      expect(screen.queryByText('Upload interrupted')).not.toBeInTheDocument();
    },
  );

  it('says "Upload interrupted", with no spinner, when no upload here names it', () => {
    render(withUploads([], <TranscriptStatusChip transcript={UPLOADING} showStage />));

    expect(screen.getByText('Upload interrupted')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/Preparing audio/)).not.toBeInTheDocument();
  });

  it('treats a failed or cancelled local upload as interrupted', () => {
    render(
      withUploads(
        [uploadIn('failed'), uploadIn('cancelled')],
        <TranscriptStatusChip transcript={UPLOADING} />,
      ),
    );

    expect(screen.getByText('Upload interrupted')).toBeInTheDocument();
  });

  it('is not fooled by a live upload for a DIFFERENT transcript', () => {
    render(
      withUploads([uploadIn('uploading', 't-other')], <TranscriptStatusChip transcript={UPLOADING} />),
    );

    expect(screen.getByText('Upload interrupted')).toBeInTheDocument();
  });

  it('keeps today\'s rendering when no upload manager is mounted', () => {
    render(<TranscriptStatusChip transcript={UPLOADING} showStage />);

    expect(screen.getByText('Uploading · Preparing audio')).toBeInTheDocument();
  });

  it('never marks a non-uploading transcript as interrupted', () => {
    render(
      withUploads(
        [],
        <TranscriptStatusChip transcript={{ ...UPLOADING, status: 'processing' }} showStage />,
      ),
    );

    expect(screen.getByText('Processing · Preparing audio')).toBeInTheDocument();
  });
});
