/**
 * Every value of `SEMANTIC_REASONS` has copy (issue #501, epic #498).
 *
 * `SemanticSearchNotice` shows the reason a search fell back to keywords as one
 * caption. A reason the notice has no sentence for falls through to
 * `describeIndexReason`, which renders `Indexing reported: <token>`: a raw
 * identifier in front of a user. The contract's list is append-only and grows
 * when the API learns a new way to degrade (`embeddings_unavailable` was the
 * latest), so this suite iterates the LIVE list: a reason added there without
 * copy here fails this test instead of shipping as a token.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { SEMANTIC_REASONS } from '@marinoscar/kvox-contract/search';

import { createFakeKvoxWebHost, renderWithKvoxHost } from '../../src/core/testing/index.js';
import { SemanticSearchNotice } from '../../src/search/ui/index.js';

beforeEach(() => {
  sessionStorage.clear();
});

describe('SemanticSearchNotice copy', () => {
  it.each(SEMANTIC_REASONS)('has a sentence for `%s`, never the raw token', (reason) => {
    renderWithKvoxHost(
      <SemanticSearchNotice semantic={false} semanticReason={reason} unindexedCount={0} />,
      createFakeKvoxWebHost()
    );

    const caption = screen.getByText(
      (_, element) =>
        element?.tagName === 'SPAN' &&
        element.classList.contains('MuiTypography-caption') &&
        (element.textContent ?? '').trim().length > 0
    );

    expect(caption.textContent?.trim().length).toBeGreaterThan(20);
    expect(caption.textContent).not.toContain(reason);
    expect(caption.textContent).not.toMatch(/^Indexing reported:/);
  });

  it('explains embeddings_unavailable without sending the reader to a fix that cannot work', () => {
    renderWithKvoxHost(
      <SemanticSearchNotice
        semantic={false}
        semanticReason="embeddings_unavailable"
        unindexedCount={0}
      />,
      createFakeKvoxWebHost()
    );

    expect(
      screen.getByText(
        "Search by meaning isn't available on this installation. Results match your words exactly."
      )
    ).toBeInTheDocument();
  });
});
