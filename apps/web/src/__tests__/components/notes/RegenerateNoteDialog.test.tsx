import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { RegenerateNoteDialog } from '../../../components/notes/RegenerateNoteDialog';
import type { AiConfigModel } from '../../../services/ai';
import type { Note } from '../../../services/notes';
import type { NoteTemplate } from '../../../services/noteTemplates';

/**
 * `RegenerateNoteDialog` — issue #58, extended by #109, epic #45.
 *
 * Every assertion here is about the OBJECT handed to `onConfirm`, because that
 * object is the request body and because the two most important cases have no
 * visible symptom: an unchanged confirmation must produce `{}` (the request
 * #58 sent), and a cleared context box must produce an explicit `null` rather
 * than an omission. A suite that checked which controls were on screen would
 * pass with both of those wrong.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Q3 planning — decisions',
    titleSource: 'ai',
    body: 'The first attempt.',
    status: 'ready',
    currentVersion: 2,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'tpl-1',
    templateName: 'Meeting minutes',
    sourceName: null,
    contextText: 'Ana and Ben were there.',
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: '2024-03-12T10:00:00.000Z',
    updatedAt: '2024-03-12T10:00:00.000Z',
    ...overrides,
  };
}

function template(id: string, name: string, overrides: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id,
    name,
    description: '',
    instructions: 'Write it up.',
    outputFormat: 'meeting_notes',
    structure: [],
    tone: null,
    length: null,
    model: null,
    isArchived: false,
    builtIn: false,
    hidden: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const MODELS: AiConfigModel[] = [
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_000,
    source: 'catalogue',
    derivedFrom: null,
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_000,
    source: 'catalogue',
    derivedFrom: null,
  },
];

const TEMPLATES = [template('tpl-1', 'Meeting minutes'), template('tpl-2', 'Executive brief')];

type Props = React.ComponentProps<typeof RegenerateNoteDialog>;

function renderDialog(overrides: Partial<Props> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();

  const view = render(
    <RegenerateNoteDialog
      open
      note={note()}
      templates={TEMPLATES}
      templatesLoading={false}
      currentTemplate={TEMPLATES[0]}
      models={MODELS}
      defaultModel="gpt-4o-mini"
      busy={false}
      error={null}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );

  return { ...view, onConfirm, onCancel };
}

/** Press the confirm button inside the dialog. */
async function confirm(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Regenerate' }));
}

/** Choose `optionName` from the MUI select labelled `label`. */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  optionName: string,
) {
  await user.click(screen.getByLabelText(label));
  await user.click(await screen.findByRole('option', { name: optionName }));
}

describe('RegenerateNoteDialog — the two facts #58 put here', () => {
  it('still says it costs the user money, and still says nothing is lost', () => {
    // ⚠ #109 ADDED CONTROLS ABOVE THESE SENTENCES AND CHANGED NEITHER. They are
    // about what pressing the button does, which has not moved.
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: 'Regenerate this note?' });
    expect(within(dialog).getByText(/costs you money again/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing is lost/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/version 2/i)).toBeInTheDocument();
  });
});

describe('RegenerateNoteDialog — what it opens on', () => {
  it('prefills the template, the context and the model from the note', () => {
    renderDialog();

    expect(screen.getByLabelText('Template')).toHaveTextContent('Meeting minutes');
    expect(screen.getByLabelText('Context')).toHaveValue('Ana and Ben were there.');
    // The model's LABEL, not its vendor id.
    expect(screen.getByLabelText('Model')).toHaveTextContent('GPT-4o mini');
  });

  it('opens on an empty context box for a note that has none', () => {
    renderDialog({ note: note({ contextText: null }) });

    expect(screen.getByLabelText('Context')).toHaveValue('');
  });

  it('falls back to the TEMPLATE’s model when the note recorded none', () => {
    renderDialog({
      note: note({ model: null }),
      currentTemplate: template('tpl-1', 'Meeting minutes', { model: 'gpt-4o' }),
      templates: [template('tpl-1', 'Meeting minutes', { model: 'gpt-4o' }), TEMPLATES[1]],
    });

    expect(screen.getByLabelText('Model')).toHaveTextContent('GPT-4o');
  });

  it('falls back to the DEPLOYMENT default when neither names a permitted model', () => {
    renderDialog({ note: note({ model: 'retired-model' }), defaultModel: 'gpt-4o' });

    expect(screen.getByLabelText('Model')).toHaveTextContent('GPT-4o');
  });

  it('offers an ARCHIVED current template that the list cannot carry', () => {
    // ⚠ `GET /api/note-templates` EXCLUDES ARCHIVED ROWS. Without this, the
    // select would render blank over a perfectly valid choice and force the
    // user to change a template they never asked to change.
    renderDialog({
      templates: [TEMPLATES[1]],
      currentTemplate: template('tpl-1', 'Meeting minutes', { isArchived: true }),
    });

    expect(screen.getByLabelText('Template')).toHaveTextContent(
      'Meeting minutes (current, archived)',
    );
  });
});

describe('RegenerateNoteDialog — the body it confirms with', () => {
  it('sends `{}` when nothing was changed', async () => {
    // ⚠ THE COMPATIBILITY ASSERTION: byte-for-byte the request #58's dialog
    // sent, so "the same again" still means the same again.
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await confirm(user);

    expect(onConfirm).toHaveBeenCalledWith({});
  });

  it('sends `contextText: null` when the user clears the box', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await user.clear(screen.getByLabelText('Context'));
    await confirm(user);

    // NOT an omission — omitting it would regenerate with the very context the
    // user just deleted.
    expect(onConfirm).toHaveBeenCalledWith({ contextText: null });
  });

  it('sends only the template and the model when only those changed', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await choose(user, 'Template', 'Executive brief');
    await choose(user, 'Model', 'GPT-4o');
    await confirm(user);

    expect(onConfirm).toHaveBeenCalledWith({ templateId: 'tpl-2', model: 'gpt-4o' });
  });

  it('sends replacement context text, trimmed', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    const box = screen.getByLabelText('Context');
    await user.clear(box);
    await user.type(box, '  Only Ana this time.  ');
    await confirm(user);

    expect(onConfirm).toHaveBeenCalledWith({ contextText: 'Only Ana this time.' });
  });

  it('stops the context at the API’s own ceiling rather than letting it 400', () => {
    renderDialog();

    expect(screen.getByLabelText('Context')).toHaveAttribute('maxlength', '4000');
  });
});

describe('RegenerateNoteDialog — when it must not be confirmable', () => {
  it('blocks confirm, and says why, when the note’s template is gone', async () => {
    // The API nulls `templateId` when the row is deleted; there is nothing to
    // keep, so the user has to choose — and until they do, `POST /regenerate`
    // would answer 409 `template_required`.
    renderDialog({ note: note({ templateId: null, templateName: null }), currentTemplate: null });

    expect(
      screen.getByText('The template this note used no longer exists — choose one'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled();
  });

  it('becomes confirmable once a template is chosen', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      note: note({ templateId: null, templateName: null }),
      currentTemplate: null,
    });

    await choose(user, 'Template', 'Executive brief');
    await confirm(user);

    expect(onConfirm).toHaveBeenCalledWith({ templateId: 'tpl-2' });
  });

  it('blocks confirm while the model list has not arrived', () => {
    // ⚠ NO MODELS MEANS NO REQUEST. A confirm here would send a regeneration
    // whose model the user never saw — or, worse, a blank one.
    renderDialog({ models: [], defaultModel: null });

    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled();
    expect(screen.getByText('Checking which models you can use…')).toBeInTheDocument();
  });

  it('is busy-safe: confirm and cancel are both disabled mid-flight', () => {
    renderDialog({ busy: true });

    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});

describe('RegenerateNoteDialog — a model the deployment no longer permits', () => {
  it('names BOTH the retired model and its replacement', () => {
    // "That model is unavailable" with no replacement leaves the user unable to
    // tell what they are about to pay for.
    renderDialog({ note: note({ model: 'gpt-3.5-turbo' }), defaultModel: 'gpt-4o' });

    expect(
      screen.getByText(
        'The model this note used (gpt-3.5-turbo) is no longer permitted; GPT-4o will be used',
      ),
    ).toBeInTheDocument();
  });

  it('says nothing of the kind while the model list is merely still loading', () => {
    // The same note, with an unanswered `GET /api/ai/config`: claiming the
    // model was withdrawn would be inventing a policy change out of latency.
    renderDialog({ note: note({ model: 'gpt-3.5-turbo' }), models: [] });

    expect(screen.queryByText(/no longer permitted/)).not.toBeInTheDocument();
  });

  it('still confirms with the note’s own model when it IS permitted', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await confirm(user);

    expect(onConfirm).toHaveBeenCalledWith({});
  });
});

describe('RegenerateNoteDialog — errors and accessibility', () => {
  it('shows a refusal without closing over it', () => {
    renderDialog({ error: 'Choose a template to regenerate with' });

    expect(screen.getByRole('alert')).toHaveTextContent('Choose a template to regenerate with');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    renderDialog();

    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// #312 — the template select gained groups, hidden-template labelling, a
// "Show hidden templates" checkbox and a change-template caption
// =============================================================================

describe('RegenerateNoteDialog — the option groups', () => {
  it('shows Current, Your templates and Built-in subheaders, in that order', async () => {
    const user = userEvent.setup();
    renderDialog({
      templates: [
        template('tpl-1', 'Meeting minutes'),
        template('tpl-2', 'Executive brief'),
        template('tpl-3', 'Weekly digest', { builtIn: true }),
      ],
    });

    await user.click(screen.getByLabelText('Template'));

    const listbox = await screen.findByRole('listbox');
    const headings = within(listbox)
      .getAllByText(/^(Current|Your templates|Built-in)$/)
      .map((el) => el.textContent);
    expect(headings).toEqual(['Current', 'Your templates', 'Built-in']);
  });

  it('renders each group heading as a subheader, not as a selectable menu item', async () => {
    const user = userEvent.setup();
    renderDialog({
      templates: [template('tpl-1', 'Meeting minutes'), template('tpl-2', 'Executive brief')],
    });

    await user.click(screen.getByLabelText('Template'));

    const heading = await screen.findByText('Your templates');
    // A real choice is a `MenuItem` (`MuiMenuItem-root`); a group heading is a
    // `ListSubheader` (`MuiListSubheader-root`) — a different element entirely,
    // whatever ARIA role MUI's Select happens to stamp onto its children.
    expect(heading.className).toContain('MuiListSubheader-root');
    expect(heading.className).not.toContain('MuiMenuItem-root');
  });
});

describe('RegenerateNoteDialog — hidden-template labelling', () => {
  it('labels a hidden current template "(current, hidden)", and it stays selectable', async () => {
    const user = userEvent.setup();
    renderDialog({
      currentTemplate: template('tpl-1', 'Meeting minutes', { hidden: true }),
      templates: [template('tpl-1', 'Meeting minutes', { hidden: true }), TEMPLATES[1]],
    });

    expect(screen.getByLabelText('Template')).toHaveTextContent(
      'Meeting minutes (current, hidden)',
    );

    await user.click(screen.getByLabelText('Template'));
    const option = await screen.findByRole('option', {
      name: 'Meeting minutes (current, hidden)',
    });
    await user.click(option);

    expect(screen.getByLabelText('Template')).toHaveTextContent(
      'Meeting minutes (current, hidden)',
    );
  });

  it('labels a current template that is both archived and hidden "(current, archived, hidden)"', () => {
    renderDialog({
      templates: [TEMPLATES[1]],
      currentTemplate: template('tpl-1', 'Meeting minutes', { isArchived: true, hidden: true }),
    });

    expect(screen.getByLabelText('Template')).toHaveTextContent(
      'Meeting minutes (current, archived, hidden)',
    );
  });

  it('labels any other hidden entry "<name> (hidden)"', async () => {
    const user = userEvent.setup();
    renderDialog({
      templates: [TEMPLATES[0], template('tpl-2', 'Executive brief', { hidden: true })],
    });

    await user.click(screen.getByLabelText('Template'));

    expect(await screen.findByRole('option', { name: 'Executive brief (hidden)' })).toBeInTheDocument();
  });
});

describe('RegenerateNoteDialog — the summary tracks the selection', () => {
  it('updates the template summary when a different template is chosen', async () => {
    const user = userEvent.setup();
    renderDialog({
      templates: [
        TEMPLATES[0],
        template('tpl-2', 'Executive brief', { description: 'A one-paragraph readout.' }),
      ],
    });

    expect(screen.queryByText('A one-paragraph readout.')).not.toBeInTheDocument();

    await choose(user, 'Template', 'Executive brief');

    expect(await screen.findByText('A one-paragraph readout.')).toBeInTheDocument();
  });

  it('shows the change-template caption only once the selection differs from the note’s own', async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.queryByText(/Changing the template rewrites/)).not.toBeInTheDocument();

    await choose(user, 'Template', 'Executive brief');

    expect(screen.getByText(/Changing the template rewrites/)).toBeInTheDocument();
  });
});

describe('RegenerateNoteDialog — initialFocus', () => {
  it('focuses the template select when initialFocus is "template"', () => {
    renderDialog({ initialFocus: 'template' });

    expect(screen.getByLabelText('Template')).toHaveFocus();
  });

  it('does not autofocus the template select otherwise', () => {
    renderDialog();

    expect(screen.getByLabelText('Template')).not.toHaveFocus();
  });
});

describe('RegenerateNoteDialog — "Show hidden templates"', () => {
  it('renders only when onShowHiddenTemplatesChange is given', () => {
    renderDialog({ onShowHiddenTemplatesChange: undefined });

    expect(screen.queryByRole('checkbox', { name: 'Show hidden templates' })).not.toBeInTheDocument();
  });

  it('calls the handler with the new value when toggled', async () => {
    const user = userEvent.setup();
    const onShowHiddenTemplatesChange = vi.fn();
    renderDialog({ showHiddenTemplates: false, onShowHiddenTemplatesChange });

    await user.click(screen.getByRole('checkbox', { name: 'Show hidden templates' }));

    expect(onShowHiddenTemplatesChange).toHaveBeenCalledWith(true);
  });

  it('reflects `showHiddenTemplates` as checked', () => {
    renderDialog({ showHiddenTemplates: true, onShowHiddenTemplatesChange: vi.fn() });

    expect(screen.getByRole('checkbox', { name: 'Show hidden templates' })).toBeChecked();
  });
});

describe('RegenerateNoteDialog — confirming a changed template only', () => {
  it('sends only { templateId } when just the template changed', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await choose(user, 'Template', 'Executive brief');
    await confirm(user);

    expect(onConfirm).toHaveBeenCalledWith({ templateId: 'tpl-2' });
  });
});
