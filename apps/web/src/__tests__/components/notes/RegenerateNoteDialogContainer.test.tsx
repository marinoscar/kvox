import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { server } from '../../mocks/server';
import { render } from '../../utils/test-utils';
import { RegenerateNoteDialogContainer } from '../../../components/notes/RegenerateNoteDialogContainer';
import type { Note } from '../../../services/notes';

/**
 * `RegenerateNoteDialogContainer` — issue #109, extended by #312.
 *
 * The container owns exactly one piece of extra state over #109's original:
 * "Show hidden templates" (#312), remembered in `localStorage` under
 * `regenerate.showHiddenTemplates`. The suite is about that one thing —
 * whether toggling it re-reads the list with `includeHidden=true`, whether the
 * choice survives, and that a hostile `localStorage` cannot crash the dialog.
 */

const API_BASE = 'http://localhost:3000/api';
const STORAGE_KEY = 'regenerate.showHiddenTemplates';

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

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tpl-1',
    name: 'Meeting minutes',
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

/** Every `GET /api/note-templates` query string this test saw. */
let listRequests: string[];

type Props = React.ComponentProps<typeof RegenerateNoteDialogContainer>;

function setup(overrides: Partial<Props> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();

  const view = render(
    <RegenerateNoteDialogContainer
      open
      note={note()}
      models={[
        {
          id: 'gpt-4o-mini',
          label: 'GPT-4o mini',
          contextWindowTokens: 128_000,
          maxOutputTokens: 16_000,
          source: 'catalogue',
          derivedFrom: null,
        },
      ]}
      defaultModel="gpt-4o-mini"
      busy={false}
      error={null}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );

  return { ...view, onCancel, onConfirm };
}

beforeEach(() => {
  listRequests = [];
  localStorage.removeItem(STORAGE_KEY);
  server.use(
    http.get(`${API_BASE}/note-templates`, ({ request }) => {
      listRequests.push(new URL(request.url).search);
      return HttpResponse.json({
        data: { items: [templateRow(), templateRow({ id: 'tpl-2', name: 'Executive brief' })], total: 2 },
      });
    }),
    http.get(`${API_BASE}/note-templates/:id`, ({ params }) =>
      HttpResponse.json({ data: templateRow({ id: params.id as string }) }),
    ),
  );
});

describe('RegenerateNoteDialogContainer — the hidden-templates checkbox', () => {
  it('reads the list without includeHidden by default', async () => {
    setup();

    await waitFor(() => expect(listRequests.length).toBeGreaterThan(0));
    expect(listRequests[0]).not.toContain('includeHidden');
  });

  it('re-reads the list with includeHidden=true when checked', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('Template');
    const before = listRequests.length;

    await user.click(screen.getByRole('checkbox', { name: 'Show hidden templates' }));

    await waitFor(() => expect(listRequests.length).toBeGreaterThan(before));
    expect(listRequests[listRequests.length - 1]).toContain('includeHidden=true');
  });

  it('persists the choice to localStorage', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('Template');

    await user.click(screen.getByRole('checkbox', { name: 'Show hidden templates' }));

    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('true'));
  });

  it('opens already checked when a prior choice was stored', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    setup();

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Show hidden templates' })).toBeChecked(),
    );
    expect(listRequests.some((query) => query.includes('includeHidden=true'))).toBe(true);
  });

  it('does not crash when localStorage throws on read or write', async () => {
    // ⚠ ONLY THIS DIALOG'S OWN KEY. Throwing for every key would also break
    // `ThemeContextProvider`, which reads its own `theme_mode` key on mount —
    // a failure that has nothing to do with what this test is about.
    const originalGetItem = Storage.prototype.getItem.bind(localStorage);
    const originalSetItem = Storage.prototype.setItem.bind(localStorage);
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
      if (key === STORAGE_KEY) throw new Error('blocked');
      return originalGetItem(key);
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      if (key === STORAGE_KEY) throw new Error('blocked');
      return originalSetItem(key, value);
    });

    try {
      const user = userEvent.setup();
      setup();
      await screen.findByLabelText('Template');

      // Toggling still works for this dialog's own lifetime even though
      // nothing can be remembered.
      await user.click(screen.getByRole('checkbox', { name: 'Show hidden templates' }));
      expect(screen.getByRole('checkbox', { name: 'Show hidden templates' })).toBeChecked();
    } finally {
      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
    }
  });
});
