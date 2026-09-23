import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { NoteGenerationContext } from '../../../components/notes/NoteGenerationContext';
import type { Note } from '../../../services/notes';
import type { NoteTemplate } from '../../../services/noteTemplates';

/**
 * `NoteGenerationContext` — issue #109, epic #45.
 *
 * The panel answers "what was this note actually made from?", and the field it
 * exists for is `contextText`: free text the user typed at `/notes/new`, placed
 * ahead of the source in every prompt, and — before this component — rendered
 * nowhere in the application. So the assertions are about WHICH FACTS REACH THE
 * SCREEN, and about the four ways a template can be unavailable without the
 * note being wrong.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Q3 planning — decisions',
    titleSource: 'ai',
    body: 'Body.',
    status: 'ready',
    currentVersion: 1,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'tpl-1',
    templateName: 'Executive summary',
    contextText: 'Ana and Ben were there.\nThe budget line is the point.',
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: '2024-03-12T10:00:00.000Z',
    updatedAt: '2024-03-12T10:00:00.000Z',
    ...overrides,
  };
}

function template(overrides: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id: 'tpl-1',
    name: 'Executive summary',
    description: 'Short, for people who were not there.',
    instructions: 'Write it up in under a page.\nLead with the decision.',
    outputFormat: 'summary',
    structure: ['Decisions', 'Owners', 'Risks'],
    tone: 'Neutral',
    length: 'Under a page',
    model: null,
    isArchived: false,
    builtIn: false,
    hidden: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof NoteGenerationContext>> = {}) {
  return render(
    <NoteGenerationContext
      note={note()}
      sourceName="Q3 planning call"
      template={template()}
      templateState="loaded"
      {...props}
    />,
  );
}

/** Press the disclosure and hand back the region it controls. */
async function expand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /How this note was generated/i }));

  return screen.getByRole('button', { name: /How this note was generated/i });
}

describe('NoteGenerationContext — the disclosure', () => {
  it('is collapsed by default, and says so to assistive technology', () => {
    renderPanel();

    const button = screen.getByRole('button', { name: /How this note was generated/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'note-generation-context');
    // ⚠ NOT MERELY HIDDEN — the template's instructions can be twenty thousand
    // characters, and a collapsed panel must not put them in the tab order.
    expect(screen.queryByText('Instructions')).not.toBeInTheDocument();
  });

  it('opens on the header, and flips aria-expanded with it', async () => {
    const user = userEvent.setup();
    renderPanel();

    const button = await expand(user);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Instructions')).toBeInTheDocument();
  });

  it('can be opened from the keyboard alone', async () => {
    const user = userEvent.setup();
    renderPanel();

    const button = screen.getByRole('button', { name: /How this note was generated/i });
    button.focus();
    await user.keyboard('{Enter}');

    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('starts open when the caller asks for it', () => {
    renderPanel({ defaultExpanded: true });

    expect(screen.getByText('Instructions')).toBeInTheDocument();
  });
});

describe('NoteGenerationContext — every field', () => {
  it('names the source and links to it', async () => {
    const user = userEvent.setup();
    renderPanel();
    await expand(user);

    expect(screen.getByRole('link', { name: 'Q3 planning call' })).toHaveAttribute(
      'href',
      '/transcripts/t1',
    );
  });

  it('falls back to the CATEGORY NOUN rather than to an id', async () => {
    const user = userEvent.setup();
    renderPanel({ sourceName: null });
    await expand(user);

    expect(screen.getByRole('link', { name: 'a transcript' })).toBeInTheDocument();
    expect(screen.getByTestId('note-generation-context')).not.toHaveTextContent('t1');
  });

  it('NAMES an uploaded document without inventing a link to it', async () => {
    // ⚠ A `managed_by: 'notes'` object has no route in this application, so
    // there is nothing to link to — the rule `noteSourcePath` documents and
    // `NoteProvenance` already follows.
    const user = userEvent.setup();
    renderPanel({
      note: note({ sourceType: 'document', sourceTranscriptId: null, sourceObjectId: 'obj-1' }),
      sourceName: 'board-pack.pdf',
    });
    await expand(user);

    expect(screen.getByText('board-pack.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'board-pack.pdf' })).not.toBeInTheDocument();
  });

  it('shows the template’s whole recipe — instructions, format, structure, tone, length', async () => {
    const user = userEvent.setup();
    renderPanel();
    await expand(user);

    // The instructions verbatim, newlines and all: `GET /api/notes/{id}` does
    // not carry them at all, which is why the template has to be read.
    expect(
      screen.getByText(/Write it up in under a page\./),
    ).toBeInTheDocument();
    // The LABEL for the format, not the wire value `summary`.
    expect(screen.getByText('Summary')).toBeInTheDocument();
    const sections = screen.getByRole('list');
    expect(within(sections).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Decisions',
      'Owners',
      'Risks',
    ]);
    expect(screen.getByText('Neutral')).toBeInTheDocument();
    expect(screen.getByText('Under a page')).toBeInTheDocument();
  });

  it('omits Structure, Tone and Length rather than drawing them empty', async () => {
    // Drawn empty, these rows would ASSERT that the template had no shape and
    // no tone — a different claim from "it did not specify one".
    const user = userEvent.setup();
    renderPanel({ template: template({ structure: [], tone: null, length: null }) });
    await expand(user);

    expect(screen.queryByText('Structure')).not.toBeInTheDocument();
    expect(screen.queryByText('Tone')).not.toBeInTheDocument();
    expect(screen.queryByText('Length')).not.toBeInTheDocument();
  });

  it('shows the CONTEXT TEXT — the field this panel exists for', async () => {
    const user = userEvent.setup();
    renderPanel();
    await expand(user);

    expect(screen.getByText(/Ana and Ben were there\./)).toBeInTheDocument();
  });

  it('says "None provided" rather than leaving the context blank', async () => {
    const user = userEvent.setup();
    renderPanel({ note: note({ contextText: null }) });
    await expand(user);

    expect(screen.getByText('None provided')).toBeInTheDocument();
  });

  it('names the model and the provider beside it', async () => {
    const user = userEvent.setup();
    renderPanel();
    await expand(user);

    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByText(/openai/)).toBeInTheDocument();
  });

  it('says "not recorded" for a note whose model was never stored', async () => {
    const user = userEvent.setup();
    renderPanel({ note: note({ model: null }) });
    await expand(user);

    expect(screen.getByText('not recorded')).toBeInTheDocument();
  });
});

describe('NoteGenerationContext — the four ways a template can be unavailable', () => {
  it('says the template was DELETED when the note carries no id', async () => {
    const user = userEvent.setup();
    renderPanel({
      note: note({ templateId: null }),
      template: null,
      templateState: 'idle',
    });
    await expand(user);

    expect(screen.getByText(/this template was deleted/i)).toBeInTheDocument();
    // …and still names it, because the API keeps the denormalised name.
    expect(screen.getByText(/Executive summary/)).toBeInTheDocument();
    // No recipe rows: there is no row to read one off.
    expect(screen.queryByText('Instructions')).not.toBeInTheDocument();
  });

  it('says the caller has no ACCESS when the read was a 404 or a 403', async () => {
    // ⚠ NOT AN ERROR. `useNoteTemplateDetail` maps both statuses to `missing`
    // precisely so this sentence can be written — the note is fine.
    const user = userEvent.setup();
    renderPanel({ template: null, templateState: 'missing' });
    await expand(user);

    expect(
      screen.getByText('You no longer have access to this template'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a skeleton, not a sentence, while the template is still being read', async () => {
    const user = userEvent.setup();
    renderPanel({ template: null, templateState: 'loading' });
    await expand(user);

    expect(screen.getByLabelText('Loading the template')).toBeInTheDocument();
    expect(screen.queryByText(/no longer have access/i)).not.toBeInTheDocument();
  });

  it('shows the API’s own message on a real error', async () => {
    const user = userEvent.setup();
    renderPanel({
      template: null,
      templateState: 'error',
      templateError: 'The service is temporarily unavailable.',
    });
    await expand(user);

    expect(screen.getByText('The service is temporarily unavailable.')).toBeInTheDocument();
  });

  it('still says something true when the error carried no message', async () => {
    const user = userEvent.setup();
    renderPanel({ template: null, templateState: 'error' });
    await expand(user);

    expect(screen.getByText('This template could not be loaded')).toBeInTheDocument();
  });
});

describe('NoteGenerationContext — the template’s own chips', () => {
  it('marks a BUILT-IN template', async () => {
    const user = userEvent.setup();
    renderPanel({ template: template({ builtIn: true }) });
    await expand(user);

    expect(screen.getByText('built-in')).toBeInTheDocument();
    expect(screen.queryByText('archived')).not.toBeInTheDocument();
  });

  it('marks an ARCHIVED template', async () => {
    // A note generated from a template that has since been archived is an
    // ordinary note; the chip says why it is not in the picker any more.
    const user = userEvent.setup();
    renderPanel({ template: template({ isArchived: true }) });
    await expand(user);

    expect(screen.getByText('archived')).toBeInTheDocument();
    expect(screen.queryByText('built-in')).not.toBeInTheDocument();
  });
});

describe('NoteGenerationContext — copy buttons (issue #308)', () => {
  it('offers a copy button for Instructions only while a template is loaded', async () => {
    const user = userEvent.setup();
    renderPanel();
    await expand(user);

    expect(screen.getByRole('button', { name: 'Copy instructions' })).toBeInTheDocument();
  });

  it('offers no copy button for Instructions when there is no template row to read', async () => {
    const user = userEvent.setup();
    renderPanel({ note: note({ templateId: null }), template: null, templateState: 'idle' });
    await expand(user);

    expect(screen.queryByRole('button', { name: 'Copy instructions' })).not.toBeInTheDocument();
  });

  it('offers a copy button for Context only while there is context text to copy', async () => {
    const user = userEvent.setup();
    renderPanel();
    await expand(user);

    expect(screen.getByRole('button', { name: 'Copy context' })).toBeInTheDocument();
  });

  it('offers no copy button for Context when none was provided', async () => {
    const user = userEvent.setup();
    renderPanel({ note: note({ contextText: null }) });
    await expand(user);

    expect(screen.queryByRole('button', { name: 'Copy context' })).not.toBeInTheDocument();
    expect(screen.getByText('None provided')).toBeInTheDocument();
  });
});

describe('NoteGenerationContext — "View full context sent to the AI" (issue #308)', () => {
  it('is absent when the caller passes no onOpenContext', async () => {
    const user = userEvent.setup();
    renderPanel();
    await expand(user);

    expect(
      screen.queryByRole('button', { name: 'View full context sent to the AI' }),
    ).not.toBeInTheDocument();
  });

  it('calls onOpenContext when pressed', async () => {
    const user = userEvent.setup();
    const onOpenContext = vi.fn();
    renderPanel({ onOpenContext });
    await expand(user);

    await user.click(screen.getByRole('button', { name: 'View full context sent to the AI' }));

    expect(onOpenContext).toHaveBeenCalledTimes(1);
  });

  it('is disabled, with an explanatory caption, when the note has never generated', async () => {
    const user = userEvent.setup();
    const onOpenContext = vi.fn();
    renderPanel({
      note: note({ currentGenerationId: null }),
      onOpenContext,
    });
    await expand(user);

    const button = screen.getByRole('button', { name: 'View full context sent to the AI' });
    expect(button).toBeDisabled();
    expect(screen.getByText('Available once generation starts')).toBeInTheDocument();
  });

  it('is enabled once a generation exists', async () => {
    const user = userEvent.setup();
    renderPanel({ onOpenContext: vi.fn() });
    await expand(user);

    expect(
      screen.getByRole('button', { name: 'View full context sent to the AI' }),
    ).toBeEnabled();
    expect(screen.queryByText('Available once generation starts')).not.toBeInTheDocument();
  });
});

describe('NoteGenerationContext — accessibility', () => {
  it('has no axe violations while collapsed', async () => {
    const { container } = renderPanel();

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations while expanded', async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await expand(user);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme', async () => {
    // ⚠ THROUGH `localStorage` — the helper's `theme` option is declared and
    // not read, so passing it would render the light theme and assert nothing.
    localStorage.setItem('theme_mode', 'dark');
    const user = userEvent.setup();
    const { container } = renderPanel();
    await expand(user);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    localStorage.setItem('theme_mode', 'light');
  });
});
