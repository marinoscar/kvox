import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { RegenerateMenuButton } from '../../../components/notes/RegenerateMenuButton';
import type { Note } from '../../../services/notes';

/**
 * `RegenerateMenuButton` — the split button issue #312 puts in front of both
 * regenerate entry points.
 *
 * The main part and the arrow are two different affordances, and the suite is
 * organised around that split: "one click for the common case" vs. "the arrow
 * opens everything else". The `templateId: null` branch gets its own block
 * because it changes what BOTH parts do, not just one of them.
 */

// `region`: the standalone button renders outside any landmark in this test
// harness, exactly like `TranscriptsLibraryView.test.tsx`'s own note.
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } };

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
    contextText: null,
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: '2024-03-12T10:00:00.000Z',
    updatedAt: '2024-03-12T10:00:00.000Z',
    ...overrides,
  };
}

type Props = React.ComponentProps<typeof RegenerateMenuButton>;

function setup(overrides: Partial<Props> = {}) {
  const onRegenerateSame = vi.fn();
  const onRegenerateWithOptions = vi.fn();

  const view = render(
    <RegenerateMenuButton
      note={note()}
      onRegenerateSame={onRegenerateSame}
      onRegenerateWithOptions={onRegenerateWithOptions}
      {...overrides}
    />,
  );

  return { ...view, onRegenerateSame, onRegenerateWithOptions };
}

describe('RegenerateMenuButton — the main part', () => {
  it('calls onRegenerateSame on a plain click, when the note has a template', async () => {
    const user = userEvent.setup();
    const { onRegenerateSame, onRegenerateWithOptions } = setup();

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(onRegenerateSame).toHaveBeenCalledTimes(1);
    expect(onRegenerateWithOptions).not.toHaveBeenCalled();
  });
});

describe('RegenerateMenuButton — the arrow and its menu', () => {
  it('opens the menu, with the popup relationship stated on the arrow button', async () => {
    const user = userEvent.setup();
    setup();

    const arrow = screen.getByRole('button', { name: 'More regenerate options' });
    expect(arrow).toHaveAttribute('aria-haspopup', 'menu');
    expect(arrow).toHaveAttribute('aria-expanded', 'false');

    await user.click(arrow);

    expect(arrow).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('"Regenerate with same template" names the template and calls onRegenerateSame', async () => {
    const user = userEvent.setup();
    const { onRegenerateSame } = setup();

    await user.click(screen.getByRole('button', { name: 'More regenerate options' }));
    const item = await screen.findByRole('menuitem', { name: /Regenerate with same template/ });
    expect(item).toHaveTextContent('Meeting minutes');

    await user.click(item);

    expect(onRegenerateSame).toHaveBeenCalledTimes(1);
  });

  it('"another template…" calls onRegenerateWithOptions', async () => {
    const user = userEvent.setup();
    const { onRegenerateWithOptions } = setup();

    await user.click(screen.getByRole('button', { name: 'More regenerate options' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Regenerate with another template…' }),
    );

    expect(onRegenerateWithOptions).toHaveBeenCalledTimes(1);
  });
});

describe('RegenerateMenuButton — a note whose template was deleted', () => {
  it('routes the main click straight to the options dialog', async () => {
    const user = userEvent.setup();
    const { onRegenerateSame, onRegenerateWithOptions } = setup({
      note: note({ templateId: null, templateName: null }),
    });

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(onRegenerateWithOptions).toHaveBeenCalledTimes(1);
    expect(onRegenerateSame).not.toHaveBeenCalled();
  });

  it('disables "same template" in the menu, and says why', async () => {
    const user = userEvent.setup();
    setup({ note: note({ templateId: null, templateName: null }) });

    await user.click(screen.getByRole('button', { name: 'More regenerate options' }));
    const item = await screen.findByRole('menuitem', { name: /Regenerate with same template/ });

    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('The template this note used was deleted');
  });
});

describe('RegenerateMenuButton — disabled', () => {
  it('disables both the main button and the arrow', () => {
    setup({ disabled: true });

    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More regenerate options' })).toBeDisabled();
  });
});

describe('RegenerateMenuButton — accessibility', () => {
  it('has no axe violations, menu open', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'More regenerate options' }));
    await screen.findByRole('menu');

    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });
});
