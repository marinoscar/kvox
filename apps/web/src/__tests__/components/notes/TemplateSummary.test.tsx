import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { TemplateSummary } from '../../../components/notes/TemplateSummary';
import type { NoteTemplate } from '../../../services/noteTemplates';

/**
 * `TemplateSummary` — what a template actually is, shown under the regenerate
 * dialog's template select, issue #312.
 *
 * Five states (`idle`/`loading`/`loaded`/`missing`/`error`), and the suite
 * follows them. `idle` renders nothing and is exercised implicitly by every
 * other component's default — there is nothing to assert about an empty box
 * beyond `aria-live` being present, which the last block covers.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function template(overrides: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id: 'tpl-1',
    name: 'Meeting minutes',
    description: 'Who decided what, and who owns it next.',
    instructions: 'Lead with the decisions.',
    outputFormat: 'meeting_notes',
    structure: ['Decisions', 'Owners', 'Risks'],
    tone: 'Neutral',
    length: 'Under a page',
    model: 'gpt-4o-mini',
    isArchived: false,
    builtIn: false,
    hidden: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TemplateSummary — loaded, everything present', () => {
  it('shows the description, the format, the sections and the tone/length/model facts', () => {
    render(<TemplateSummary template={template()} state="loaded" />);

    expect(
      screen.getByText('Who decided what, and who owns it next.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Meeting notes')).toBeInTheDocument();
    expect(screen.getByText('Decisions')).toBeInTheDocument();
    expect(screen.getByText('Owners')).toBeInTheDocument();
    expect(screen.getByText('Risks')).toBeInTheDocument();
    // The tone fact is on its own (no leading separator), so an exact match
    // works; length and model are preceded by a literal ` · ` text node
    // sibling, so those two are matched by substring instead.
    expect(screen.getByText('Neutral')).toBeInTheDocument();
    expect(screen.getByText(/Under a page/)).toBeInTheDocument();
    expect(screen.getByText(/gpt-4o-mini/)).toBeInTheDocument();
  });
});

describe('TemplateSummary — the section list caps at 6', () => {
  it('shows the first six sections and collapses the rest into "+N more"', () => {
    const sections = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
    render(<TemplateSummary template={template({ structure: sections })} state="loaded" />);

    for (const section of sections.slice(0, 6)) {
      expect(screen.getByText(section)).toBeInTheDocument();
    }
    expect(screen.queryByText('Seven')).not.toBeInTheDocument();
    expect(screen.queryByText('Eight')).not.toBeInTheDocument();
    expect(screen.getByText(/\+2 more/)).toBeInTheDocument();
  });

  it('shows no "+N more" when there are 6 sections or fewer', () => {
    render(
      <TemplateSummary
        template={template({ structure: ['One', 'Two'] })}
        state="loaded"
      />,
    );

    expect(screen.queryByText(/\+\d+ more/)).not.toBeInTheDocument();
  });
});

describe('TemplateSummary — omitted fields', () => {
  it('omits tone, length and model when the template names none of them', () => {
    render(
      <TemplateSummary
        template={template({ tone: null, length: null, model: null })}
        state="loaded"
      />,
    );

    expect(screen.queryByText('Tone:')).not.toBeInTheDocument();
    expect(screen.queryByText('Length:')).not.toBeInTheDocument();
    expect(screen.queryByText('Model:')).not.toBeInTheDocument();
  });

  it('omits the description block when the template has none', () => {
    render(<TemplateSummary template={template({ description: '' })} state="loaded" />);

    expect(
      screen.queryByText('Who decided what, and who owns it next.'),
    ).not.toBeInTheDocument();
  });
});

describe('TemplateSummary — loading', () => {
  it('renders a skeleton, marked aria-busy', () => {
    render(<TemplateSummary template={null} state="loading" />);

    const box = screen.getByTestId('template-summary');
    expect(box).toHaveAttribute('aria-busy', 'true');
  });
});

describe('TemplateSummary — missing and error', () => {
  it('says the details are no longer available, for `missing`', () => {
    render(<TemplateSummary template={null} state="missing" />);

    expect(
      screen.getByText('This template’s details are no longer available to you.'),
    ).toBeInTheDocument();
  });

  it('says the details could not be loaded, for `error`', () => {
    render(<TemplateSummary template={null} state="error" />);

    expect(
      screen.getByText('This template’s details could not be loaded.'),
    ).toBeInTheDocument();
  });
});

describe('TemplateSummary — accessibility', () => {
  it('is an aria-live region in every state', () => {
    const { rerender } = render(<TemplateSummary template={null} state="idle" />);
    expect(screen.getByTestId('template-summary')).toHaveAttribute('aria-live', 'polite');

    rerender(<TemplateSummary template={template()} state="loaded" />);
    expect(screen.getByTestId('template-summary')).toHaveAttribute('aria-live', 'polite');
  });

  it('has no axe violations, loaded', async () => {
    render(<TemplateSummary template={template()} state="loaded" />);

    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});
