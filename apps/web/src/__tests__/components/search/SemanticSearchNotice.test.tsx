/**
 * The library feed's keyword-only line (issue #191, epic #165).
 *
 * The first test is the important one, and it is about a field that DOES NOT
 * EXIST YET: `semantic` arrives with this epic's hybrid-ranking issue, so every
 * response today reports `undefined`. `undefined` means "this build's server
 * does not report it" and is NOT the same fact as `false` ("it reported, and
 * the answer was keyword-only"). A feed that showed a degradation notice
 * because a field had not shipped would be worse than one that said nothing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import { SemanticSearchNotice } from '../../../components/search/SemanticSearchNotice';

describe('SemanticSearchNotice', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('renders NOTHING when the server did not report `semantic` at all', () => {
    const { container } = render(<SemanticSearchNotice />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the answer WAS semantic', () => {
    const { container } = render(<SemanticSearchNotice semantic unindexedCount={4} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('explains a keyword-only answer and links to the indexing page', () => {
    render(<SemanticSearchNotice semantic={false} />);

    expect(screen.getByText(/keyword-only/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /set up search indexing/i })).toHaveAttribute(
      'href',
      '/settings/search-index',
    );
  });

  it('is an INFO line, never an error — a keyword answer is still a correct answer', () => {
    render(<SemanticSearchNotice semantic={false} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('MuiAlert-colorInfo');
    expect(alert.className).not.toMatch(/colorError|colorWarning/);
  });

  it('shows the unindexed count beside the results when it is non-zero', () => {
    render(<SemanticSearchNotice semantic={false} unindexedCount={12} />);

    expect(screen.getByText(/12 of your documents/i)).toBeInTheDocument();
  });

  it('says nothing about a count of zero', () => {
    render(<SemanticSearchNotice semantic={false} unindexedCount={0} />);

    expect(screen.queryByText(/of your documents/i)).not.toBeInTheDocument();
  });

  it('renders a reported reason in plain language', () => {
    render(<SemanticSearchNotice semantic={false} semanticReason="ai_key_missing" />);

    expect(screen.getByText(/no AI provider key was saved/i)).toBeInTheDocument();
  });

  it('can be dismissed, and stays dismissed for the session', async () => {
    const user = userEvent.setup();
    const first = render(<SemanticSearchNotice semantic={false} storageKey="notice:test" />);

    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByText(/keyword-only/i)).not.toBeInTheDocument();

    first.unmount();

    // A remount — the next keystroke of the next search — stays quiet.
    render(<SemanticSearchNotice semantic={false} storageKey="notice:test" />);
    expect(screen.queryByText(/keyword-only/i)).not.toBeInTheDocument();
  });

  it('keeps each feed\'s dismissal separate', async () => {
    const user = userEvent.setup();
    const first = render(
      <SemanticSearchNotice semantic={false} storageKey="notice:transcripts" />,
    );

    await user.click(screen.getByRole('button', { name: /close/i }));
    first.unmount();

    render(<SemanticSearchNotice semantic={false} storageKey="notice:notes" />);
    expect(screen.getByText(/keyword-only/i)).toBeInTheDocument();
  });
});
