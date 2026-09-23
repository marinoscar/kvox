import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';

import { render } from '../../utils/test-utils';
import { NoteBody } from '../../../components/notes/NoteBody';

/**
 * `NoteBody` — issue #334.
 *
 * Markdown renders through `MarkdownView` (a real heading element, not the
 * literal `#`); plain text is shown exactly as written, with no markup
 * interpretation, and preserves line breaks.
 */

describe('NoteBody — markdown (the default)', () => {
  it('renders markdown through MarkdownView, producing a real heading element', () => {
    render(<NoteBody>{'# Decisions\n\nWe agreed.'}</NoteBody>);

    expect(screen.getByRole('heading', { name: 'Decisions' })).toBeInTheDocument();
  });

  it('is tagged data-body-format="markdown" when bodyFormat is absent', () => {
    const { container } = render(<NoteBody>{'Some body.'}</NoteBody>);

    expect(container.querySelector('[data-body-format="markdown"]')).toBeInTheDocument();
  });
});

describe('NoteBody — plain text', () => {
  it('shows a leading "#" verbatim, never as a heading', () => {
    render(
      <NoteBody bodyFormat="plain_text">{'# not heading\n\nJust a line starting with a hash.'}</NoteBody>,
    );

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText(/# not heading/)).toBeInTheDocument();
  });

  it('preserves whitespace with pre-wrap styling', () => {
    const { container } = render(
      <NoteBody bodyFormat="plain_text">{'Line one.\nLine two.'}</NoteBody>,
    );

    const textNode = screen.getByText(/Line one\./);
    expect(textNode).toHaveStyle({ whiteSpace: 'pre-wrap' });
    expect(container.querySelector('[data-body-format="plain_text"]')).toBeInTheDocument();
  });

  it('does not interpret markdown emphasis markers', () => {
    render(<NoteBody bodyFormat="plain_text">{'This is *not* bold.'}</NoteBody>);

    expect(screen.getByText(/This is \*not\* bold\./)).toBeInTheDocument();
    expect(screen.queryByText('not')?.tagName).not.toBe('EM');
  });
});
