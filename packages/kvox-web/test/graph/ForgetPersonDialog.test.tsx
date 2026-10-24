/**
 * `ForgetPersonDialog`'s reassurance names what the host keeps: recordings and
 * notes on KVox web, notes and transcripts in a host without transcription
 * (#731), where there are no recordings to speak of.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createFakeKvoxWebHost, renderWithKvoxHost } from '../../src/core/testing/index.js';
import { ForgetPersonDialog } from '../../src/graph/ui/components/ForgetPersonDialog.js';

function renderDialog(features: { transcription?: boolean } = {}) {
  const host = createFakeKvoxWebHost({
    viewer: { userId: 'u1', permissions: ['graph:read', 'graph:write'] },
    features: { graphEnabled: true, ...features },
  });
  return renderWithKvoxHost(
    <ForgetPersonDialog open entityId="e1" label="Grace Hopper" onClose={() => undefined} onForgotten={() => undefined} />,
    host,
  );
}

describe('ForgetPersonDialog', () => {
  it('reassures about recordings and notes by default', () => {
    renderDialog();
    expect(screen.getByText(/your recordings and notes are not changed/i)).toBeInTheDocument();
  });

  it('speaks of notes and transcripts in a host without transcription', () => {
    renderDialog({ transcription: false });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/your notes and transcripts are not changed/i);
    expect(dialog.textContent).not.toMatch(/recording|audio|transcrib/i);
  });
});
