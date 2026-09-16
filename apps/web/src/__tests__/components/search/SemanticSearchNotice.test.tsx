/**
 * The search results' keyword-only line (issue #191, epic #165).
 *
 * The first test is the important one, and it is about `semantic: null` — the
 * value `useSearch` reports before any answer has landed. The SERVER's field is
 * a required boolean (#189), so `null` is never a claim about the wire; it is
 * this app saying nobody has asked yet. A notice that appeared during the
 * debounce of every first keystroke would be worse than one that said nothing.
 *
 * ⚠ These props were OPTIONAL while the fields were wired to the list feeds as
 * a placeholder. They are required now, because the fields they mirror live on
 * `GET /api/search` and that endpoint always sends them.
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

  it('renders NOTHING before an answer has landed (`semantic: null`)', () => {
    const { container } = render(
      <SemanticSearchNotice semantic={null} semanticReason={null} unindexedCount={0} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the answer WAS semantic', () => {
    const { container } = render(
      <SemanticSearchNotice semantic semanticReason={null} unindexedCount={4} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('explains a keyword-only answer and links to the indexing page', () => {
    render(<SemanticSearchNotice semantic={false} semanticReason={null} unindexedCount={0} />);

    expect(screen.getByText(/keyword-only/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /set up search indexing/i })).toHaveAttribute(
      'href',
      '/settings/search-index',
    );
  });

  it('is an INFO line, never an error — a keyword answer is still a correct answer', () => {
    render(<SemanticSearchNotice semantic={false} semanticReason={null} unindexedCount={0} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('MuiAlert-colorInfo');
    expect(alert.className).not.toMatch(/colorError|colorWarning/);
  });

  it('shows the unindexed count beside the results when it is non-zero', () => {
    render(<SemanticSearchNotice semantic={false} semanticReason={null} unindexedCount={12} />);

    expect(screen.getByText(/12 of your documents/i)).toBeInTheDocument();
  });

  it('says nothing about a count of zero', () => {
    render(<SemanticSearchNotice semantic={false} semanticReason={null} unindexedCount={0} />);

    expect(screen.queryByText(/of your documents/i)).not.toBeInTheDocument();
  });

  it('renders a reported reason in plain language', () => {
    render(
      <SemanticSearchNotice
        semantic={false}
        semanticReason="ai_key_missing"
        unindexedCount={0}
      />,
    );

    expect(screen.getByText(/no AI provider key was saved/i)).toBeInTheDocument();
  });

  it('has a sentence for the two SEARCH-ONLY reasons, never a raw token', () => {
    // `no_indexed_content` and `embedding_failed` are reasons a SEARCH can
    // report and an INDEX attempt never can, so `describeIndexReason` has no
    // entry for them and would render the token itself.
    const { unmount } = render(
      <SemanticSearchNotice
        semantic={false}
        semanticReason="no_indexed_content"
        unindexedCount={0}
      />,
    );
    expect(screen.getByText(/has been indexed for semantic search yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/no_indexed_content/)).not.toBeInTheDocument();
    unmount();

    render(
      <SemanticSearchNotice
        semantic={false}
        semanticReason="embedding_failed"
        unindexedCount={0}
      />,
    );
    expect(screen.getByText(/could not turn this search into an embedding/i)).toBeInTheDocument();
    expect(screen.queryByText(/embedding_failed/)).not.toBeInTheDocument();
  });

  it('can be dismissed, and stays dismissed for the session', async () => {
    const user = userEvent.setup();
    const first = render(
      <SemanticSearchNotice
        semantic={false}
        semanticReason={null}
        unindexedCount={0}
        storageKey="notice:test"
      />,
    );

    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByText(/keyword-only/i)).not.toBeInTheDocument();

    first.unmount();

    // A remount — the next keystroke of the next search — stays quiet.
    render(
      <SemanticSearchNotice
        semantic={false}
        semanticReason={null}
        unindexedCount={0}
        storageKey="notice:test"
      />,
    );
    expect(screen.queryByText(/keyword-only/i)).not.toBeInTheDocument();
  });

  it("keeps each feed's dismissal separate", async () => {
    const user = userEvent.setup();
    const first = render(
      <SemanticSearchNotice
        semantic={false}
        semanticReason={null}
        unindexedCount={0}
        storageKey="notice:transcripts"
      />,
    );

    await user.click(screen.getByRole('button', { name: /close/i }));
    first.unmount();

    render(
      <SemanticSearchNotice
        semantic={false}
        semanticReason={null}
        unindexedCount={0}
        storageKey="notice:notes"
      />,
    );
    expect(screen.getByText(/keyword-only/i)).toBeInTheDocument();
  });
});
