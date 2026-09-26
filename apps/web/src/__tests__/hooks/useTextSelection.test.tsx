import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { useRef } from 'react';

import {
  resolveNoteSelection,
  resolveSegmentSelection,
} from '../../components/graph/selection/resolvers';
import { useTextSelection } from '../../hooks/useTextSelection';
import type { SelectionResolution } from '../../hooks/useTextSelection';
import { render } from '../utils/test-utils';

const MARKDOWN = 'Met with **Sarah** Chen about the pilot.';

function Probe({ resolve, enabled = true }: { resolve: (range: Range, c: HTMLElement) => SelectionResolution; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { selection, refusal } = useTextSelection(ref, resolve, { enabled });
  return (
    <div>
      <div ref={ref} data-testid="container">
        <p>
          Met with <strong>Sarah</strong> Chen about the pilot.
        </p>
        <p data-segment-id="s1" data-segment-rev="3">
          Tom will check with legal.
        </p>
        <p data-segment-id="s2" data-segment-rev="1">
          Ana owns the plan.
        </p>
      </div>
      <p data-testid="outside">Outside text entirely.</p>
      <output data-testid="selection">{selection ? JSON.stringify({ quote: selection.quote, source: selection.source }) : 'none'}</output>
      <output data-testid="refusal">{refusal ? refusal.refused : 'none'}</output>
    </div>
  );
}

const noteResolver = (range: Range, container: HTMLElement) =>
  resolveNoteSelection(range, container, { noteId: 'n1', noteVersion: 3, markdown: MARKDOWN });

const segmentResolver = (range: Range, container: HTMLElement) =>
  resolveSegmentSelection(range, container, {
    transcriptId: 't1',
    segmentText: (id) => (id === 's1' ? 'Tom will check with legal.' : id === 's2' ? 'Ana owns the plan.' : undefined),
  });

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.pointerUp(document);
}

function textNode(element: Element, index = 0): Text {
  return Array.from(element.childNodes).filter((node): node is Text => node.nodeType === Node.TEXT_NODE)[index];
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

describe('useTextSelection', () => {
  it('a collapsed selection is nothing', () => {
    render(<Probe resolve={noteResolver} />);
    const p = screen.getByTestId('container').querySelector('p')!;
    act(() => select(textNode(p), 2, textNode(p), 2));
    expect(screen.getByTestId('selection')).toHaveTextContent('none');
    expect(screen.getByTestId('refusal')).toHaveTextContent('none');
  });

  it('a selection outside the container is nothing', () => {
    render(<Probe resolve={noteResolver} />);
    const outside = screen.getByTestId('outside');
    act(() => select(textNode(outside), 0, textNode(outside), 7));
    expect(screen.getByTestId('selection')).toHaveTextContent('none');
  });

  it('a note selection across bold markup maps to the markdown slice', () => {
    render(<Probe resolve={noteResolver} />);
    const p = screen.getByTestId('container').querySelector('p')!;
    const strong = p.querySelector('strong')!;
    const after = textNode(p, 1); // " Chen about the pilot."
    act(() => select(textNode(strong), 0, after, ' Chen'.length));
    const value = JSON.parse(screen.getByTestId('selection').textContent!);
    expect(value.quote).toBe('Sarah** Chen');
    expect(value.source).toEqual({
      kind: 'note',
      noteId: 'n1',
      noteVersion: 3,
      charStart: MARKDOWN.indexOf('Sarah'),
      charEnd: MARKDOWN.indexOf('Sarah') + 'Sarah** Chen'.length,
    });
  });

  it('a selection within one line is a segment span with its rev', () => {
    render(<Probe resolve={segmentResolver} />);
    const line = screen.getByTestId('container').querySelector('[data-segment-id="s1"]')!;
    const text = textNode(line);
    const start = text.data.indexOf('check');
    act(() => select(text, start, text, start + 'check with'.length));
    const value = JSON.parse(screen.getByTestId('selection').textContent!);
    expect(value).toEqual({
      quote: 'check with',
      source: { kind: 'segment', transcriptId: 't1', segmentId: 's1', segmentRev: 3, charStart: 9, charEnd: 19 },
    });
  });

  it('a selection across two lines is refused with a reason', () => {
    render(<Probe resolve={segmentResolver} />);
    const container = screen.getByTestId('container');
    const first = textNode(container.querySelector('[data-segment-id="s1"]')!);
    const second = textNode(container.querySelector('[data-segment-id="s2"]')!);
    act(() => select(first, 5, second, 5));
    expect(screen.getByTestId('selection')).toHaveTextContent('none');
    expect(screen.getByTestId('refusal')).toHaveTextContent('Select within one line');
  });

  it('Escape clears the selection', () => {
    render(<Probe resolve={segmentResolver} />);
    const line = screen.getByTestId('container').querySelector('[data-segment-id="s2"]')!;
    const text = textNode(line);
    act(() => select(text, text.data.indexOf('Ana'), text, text.data.indexOf('Ana') + 3));
    expect(screen.getByTestId('selection')).not.toHaveTextContent('none');
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.getByTestId('selection')).toHaveTextContent('none');
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
  });

  it('does nothing while disabled', () => {
    render(<Probe resolve={segmentResolver} enabled={false} />);
    const line = screen.getByTestId('container').querySelector('[data-segment-id="s2"]')!;
    const text = textNode(line);
    act(() => select(text, 0, text, 5));
    expect(screen.getByTestId('selection')).toHaveTextContent('none');
  });
});
