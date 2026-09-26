import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Components } from 'react-markdown';

import remarkAskCitations, {
  stripMarkdownCode,
  stripTrailingPartialMarker,
  summarizeAskCitations,
} from '../../../components/ask/remarkAskCitations';
import { MarkdownView } from '../../../components/notes/MarkdownView';
import type { AskCitation } from '../../../services/ask';

/**
 * `remarkAskCitations` (#380): marker → citation node, evidence numbered by
 * first appearance, invalid/unknown markers removed, code left alone.
 */

function citation(overrides: Partial<AskCitation> & Pick<AskCitation, 'marker' | 'kind'>): AskCitation {
  return { id: null, via: null, valid: true, label: null, documentKind: null, startMs: null, ...overrides };
}

const CITATIONS: AskCitation[] = [
  citation({ marker: 'ev1', kind: 'evidence', id: 'evidence-a', label: 'Call' }),
  citation({ marker: 'ev2', kind: 'evidence', id: 'evidence-b' }),
  // An item marker resolved to the SAME evidence row as ev1.
  citation({ marker: 'itm3', kind: 'evidence', id: 'evidence-a', via: { kind: 'item', id: 'item-3' } }),
  citation({ marker: 'ent1', kind: 'entity', id: 'entity-joe', label: 'Joe Rivera' }),
  citation({ marker: 'doc1', kind: 'document', id: 't-1', label: 'Sync', documentKind: 'transcript', startMs: 5000 }),
  citation({ marker: 'ev9', kind: 'evidence', id: null, valid: false }),
];

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hName?: string; hProperties?: Record<string, string | number> };
}

function transform(tree: Node, citations: readonly AskCitation[] = CITATIONS): Node {
  remarkAskCitations({ citations })(tree as never);
  return tree;
}

function paragraph(...children: Node[]): Node {
  return { type: 'root', children: [{ type: 'paragraph', children }] };
}

function flatten(tree: Node): Node[] {
  return tree.children?.[0].children ?? [];
}

describe('remarkAskCitations — the tree transform', () => {
  it('maps each valid marker to a citation node carrying its kind, id and label', () => {
    const out = flatten(transform(paragraph({ type: 'text', value: 'Joe [^ent1] said so [^ev1] in [^doc1].' })));
    expect(out.map((n) => n.type)).toEqual(['text', 'askCitation', 'text', 'askCitation', 'text', 'askCitation', 'text']);
    expect(out[1].data).toEqual({
      hName: 'span',
      hProperties: { dataAskCitation: 'entity', dataAskId: 'entity-joe', dataAskMarker: 'ent1', dataAskLabel: 'Joe Rivera' },
    });
    expect(out[3].data?.hProperties).toMatchObject({ dataAskCitation: 'evidence', dataAskId: 'evidence-a', dataAskNumber: 1 });
    expect(out[5].data?.hProperties).toMatchObject({
      dataAskCitation: 'document',
      dataAskDocumentKind: 'transcript',
      dataAskStartMs: 5000,
    });
  });

  it('numbers evidence by first appearance, one number per source', () => {
    const tree = transform({
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: 'B first [^ev2]. A next [^ev1].' }] },
        { type: 'paragraph', children: [{ type: 'text', value: 'A again, via an item [^itm3]. B [^ev2].' }] },
      ],
    });
    const numbers = (tree.children ?? [])
      .flatMap((p) => p.children ?? [])
      .filter((n) => n.type === 'askCitation')
      .map((n) => n.data?.hProperties?.dataAskNumber);
    expect(numbers).toEqual([1, 2, 2, 1]);
  });

  it('removes invalid and unknown markers, tidying the seam', () => {
    const out = flatten(transform(paragraph({ type: 'text', value: 'Budget was discussed [^ev9]. Also [^ev77], [^rel4] and more.' })));
    expect(out).toEqual([{ type: 'text', value: 'Budget was discussed. Also, and more.' }]);
  });

  it('leaves text without markers, and non-text nodes such as inline code, alone', () => {
    const code: Node = { type: 'inlineCode', value: '[^ev1]' };
    const out = flatten(transform(paragraph({ type: 'text', value: 'Nothing cited ' }, code)));
    expect(out).toEqual([{ type: 'text', value: 'Nothing cited ' }, code]);
  });

  it('treats a GFM footnote reference to a marker the same way, and drops marker definitions', () => {
    const tree = transform({
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'footnoteReference', identifier: 'ev1', label: 'ev1' } as Node, { type: 'footnoteReference', identifier: 'ev9', label: 'ev9' } as Node] },
        { type: 'footnoteDefinition', identifier: 'ev1', label: 'ev1', children: [] } as Node,
      ],
    });
    expect(tree.children).toHaveLength(1);
    expect(flatten(tree).map((n) => n.type)).toEqual(['askCitation']);
  });
});

describe('remarkAskCitations — rendered through MarkdownView', () => {
  const components: Components = {
    span: ({ node, children }) => {
      const props = (node?.properties ?? {}) as Record<string, unknown>;
      if (props.dataAskCitation) {
        return <mark data-testid="cite">{`${String(props.dataAskCitation)}:${String(props.dataAskNumber ?? props.dataAskLabel)}`}</mark>;
      }
      return <span>{children}</span>;
    },
  };

  it('renders chips for valid markers, drops invalid ones, and leaves code spans alone', () => {
    render(
      <MarkdownView remarkPlugins={[[remarkAskCitations, { citations: CITATIONS }]]} components={components}>
        {'Ships in October [^ev1] with **Joe** [^ent1]; cut [^ev9].\n\nLiteral: `[^ev1]`'}
      </MarkdownView>,
    );
    expect(screen.getAllByTestId('cite').map((el) => el.textContent)).toEqual(['evidence:1', 'entity:Joe Rivera']);
    expect(screen.queryByText(/\[\^ev9\]/)).not.toBeInTheDocument();
    expect(screen.getByText('[^ev1]', { selector: 'code' })).toBeInTheDocument();
  });

  it('removes every marker while citations are not yet known (mid-stream)', () => {
    const { container } = render(
      <MarkdownView remarkPlugins={[[remarkAskCitations, { citations: [] }]]} components={components}>
        {'Partial answer [^ev1] so far'}
      </MarkdownView>,
    );
    expect(container.textContent).toBe('Partial answer so far');
  });
});

describe('summarizeAskCitations', () => {
  it('counts distinct valid and removed markers, ignoring code', () => {
    const content = 'A [^ev1] B [^ev1] C [^ev9] D [^ev77] `[^ev5]`\n\n```\n[^ev6]\n```\nE [^ent1]';
    expect(summarizeAskCitations(content, CITATIONS)).toEqual({ validCount: 2, invalidCount: 2 });
    expect(summarizeAskCitations('No markers here.', CITATIONS)).toEqual({ validCount: 0, invalidCount: 0 });
  });

  it('strips fenced and inline code', () => {
    expect(stripMarkdownCode('a `x` b\n```js\ncode\n```\nc')).toBe('a  b\n\nc');
  });
});

describe('stripTrailingPartialMarker', () => {
  it('hides a marker that is still arriving, and nothing else', () => {
    expect(stripTrailingPartialMarker('Ships soon [^ev')).toBe('Ships soon ');
    expect(stripTrailingPartialMarker('Ships soon [^')).toBe('Ships soon ');
    expect(stripTrailingPartialMarker('Ships soon [^ev1')).toBe('Ships soon ');
    expect(stripTrailingPartialMarker('Ships soon [^ev1]')).toBe('Ships soon [^ev1]');
    expect(stripTrailingPartialMarker('A list [a]')).toBe('A list [a]');
  });
});
