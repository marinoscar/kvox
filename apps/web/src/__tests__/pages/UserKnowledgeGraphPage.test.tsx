/**
 * `/settings/knowledge-graph` (issue #369, epic #346).
 *
 * Driven through MSW end to end — the real `useUserSettings`, the real
 * `useGraphPreferences`, the real transport — so every assertion about a
 * control is an assertion about the PATCH body that actually left the page.
 * The settings handler below is stateful and deep-merges the `graph`
 * namespace the way the API's `mergeGraph` does, so a control's state after a
 * save reflects what the server would answer.
 *
 * The route's permission gate is covered in `App.test.tsx`; the registry
 * entry in `config/knowledgeGraphCard.test.ts`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import { mockGraphOntology } from '../mocks/graphData';
import UserKnowledgeGraphPage from '../../pages/UserKnowledgeGraphPage';
import type { GraphPreferencesSettings } from '../../types';

const API_BASE = '*/api';
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

type Graph = Record<string, Record<string, unknown> | undefined>;

const RESOLUTION_DEFAULTS = {
  mode: 'precheck_confident',
  autoLinkThreshold: 0.9,
  newThreshold: 0.55,
  adjudication: 'llm',
};
const SUB_DEFAULTS: Record<string, Record<string, unknown>> = {
  extraction: { autoExtract: true },
  resolution: RESOLUTION_DEFAULTS,
  domains: { work: true, personal: false },
};

/** The API's `mergeGraph`, in miniature. */
function mergeGraph(current: Graph | undefined, patch: Graph | null | undefined): Graph | undefined {
  if (patch === undefined) return current;
  if (patch === null) return undefined;
  const merged: Graph = { ...(current ?? {}) };
  for (const [key, sub] of Object.entries(patch)) {
    if (sub === null) {
      delete merged[key];
      continue;
    }
    const base = { ...(merged[key] ?? SUB_DEFAULTS[key]) };
    for (const [field, value] of Object.entries(sub ?? {})) {
      base[field] = value === null ? SUB_DEFAULTS[key][field] : value;
    }
    merged[key] = base;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

let stored: { graph?: Graph; version: number };
let patches: Array<Record<string, unknown>>;
let aiConfig: Record<string, unknown>;

function settingsBody() {
  return {
    theme: 'system',
    profile: { displayName: null, imageSource: 'provider', imageObjectId: null },
    ...(stored.graph ? { graph: stored.graph } : {}),
    updatedAt: new Date().toISOString(),
    version: stored.version,
  };
}

function useHandlers(initialGraph?: GraphPreferencesSettings) {
  stored = { graph: initialGraph as Graph | undefined, version: 1 };
  patches = [];
  server.use(
    http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ data: settingsBody() })),
    http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
      const body = (await request.json()) as { graph?: Graph | null };
      patches.push(body);
      stored.graph = mergeGraph(stored.graph, body.graph);
      stored.version += 1;
      return HttpResponse.json({ data: settingsBody() });
    }),
    http.get(`${API_BASE}/ai/config`, () => HttpResponse.json({ data: aiConfig })),
  );
}

async function renderPage(initialGraph?: GraphPreferencesSettings) {
  useHandlers(initialGraph);
  const result = render(<UserKnowledgeGraphPage />);
  await screen.findByRole('heading', { level: 1, name: 'Knowledge graph' });
  return result;
}

beforeEach(() => {
  aiConfig = {
    available: true,
    provider: 'openai',
    providerLabel: 'OpenAI',
    models: [],
    defaultModel: 'gpt-x',
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    keyConfigured: true,
    graphEnabled: true,
  };
});

describe('UserKnowledgeGraphPage', () => {
  it('renders every section with the defaults when the namespace is absent', async () => {
    await renderPage();

    for (const name of ['Extraction', 'Resolution', 'Domains', 'Your attributes']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    expect(
      screen.getByRole('switch', { name: /extract a graph proposal when a note is ready/i }),
    ).toBeChecked();
    expect(screen.getByRole('radio', { name: /pre-check confident matches/i })).toBeChecked();
    expect(screen.getByRole('slider', { name: /link automatically at/i })).toHaveValue('0.9');
    expect(screen.getByRole('slider', { name: /treat as new below/i })).toHaveValue('0.55');
    expect(
      screen.getByRole('switch', { name: /ask the ai about uncertain matches/i }),
    ).toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the extraction switch PATCHes extraction.autoExtract', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('switch', { name: /extract a graph proposal/i }));

    await waitFor(() => expect(patches).toEqual([{ graph: { extraction: { autoExtract: false } } }]));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /extract a graph proposal/i })).not.toBeChecked(),
    );
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
  });

  it('the mode radio and the adjudication switch PATCH resolution fields', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('radio', { name: /let me review every row/i }));
    await waitFor(() => expect(patches).toHaveLength(1));
    await user.click(screen.getByRole('switch', { name: /ask the ai about uncertain matches/i }));
    await waitFor(() => expect(patches).toHaveLength(2));

    expect(patches).toEqual([
      { graph: { resolution: { mode: 'review_all' } } },
      { graph: { resolution: { adjudication: 'off' } } },
    ]);
  });

  it('the auto-link slider commits one PATCH per change and warns below 90 %', async () => {
    const user = userEvent.setup();
    await renderPage();

    expect(screen.queryByText(/lower than the measured-safe default/i)).not.toBeInTheDocument();

    const slider = screen.getByRole('slider', { name: /link automatically at/i });
    slider.focus();
    await user.keyboard('{ArrowLeft}');

    await waitFor(() =>
      expect(patches).toEqual([{ graph: { resolution: { autoLinkThreshold: 0.89 } } }]),
    );
    expect(screen.getByText(/lower than the measured-safe default \(90 %\)/i)).toBeInTheDocument();
  });

  it('squeezing auto-link below the new threshold sends the clamped pair together', async () => {
    const user = userEvent.setup();
    await renderPage({
      resolution: { ...RESOLUTION_DEFAULTS, autoLinkThreshold: 0.86, newThreshold: 0.81 } as never,
    });

    const slider = screen.getByRole('slider', { name: /link automatically at/i });
    slider.focus();
    await user.keyboard('{ArrowLeft}');

    await waitFor(() =>
      expect(patches).toEqual([
        { graph: { resolution: { autoLinkThreshold: 0.85, newThreshold: 0.8 } } },
      ]),
    );
  });

  it('the new-entity slider is capped 0.05 below auto-link and PATCHes newThreshold', async () => {
    const user = userEvent.setup();
    await renderPage();

    const slider = screen.getByRole('slider', { name: /treat as new below/i });
    expect(slider).toHaveAttribute('aria-valuemax', '0.85');
    slider.focus();
    await user.keyboard('{ArrowRight}');

    await waitFor(() =>
      expect(patches).toEqual([{ graph: { resolution: { newThreshold: 0.56 } } }]),
    );
  });

  it('Reset to defaults PATCHes resolution: null and restores the defaults', async () => {
    const user = userEvent.setup();
    await renderPage({
      resolution: { ...RESOLUTION_DEFAULTS, autoLinkThreshold: 0.95, mode: 'review_all' } as never,
    });
    expect(screen.getByRole('slider', { name: /link automatically at/i })).toHaveValue('0.95');

    await user.click(screen.getByRole('button', { name: /reset to defaults/i }));

    await waitFor(() => expect(patches).toEqual([{ graph: { resolution: null } }]));
    await waitFor(() =>
      expect(screen.getByRole('slider', { name: /link automatically at/i })).toHaveValue('0.9'),
    );
    expect(screen.getByRole('radio', { name: /pre-check confident matches/i })).toBeChecked();
  });

  it('says so when connected knowledge is off on this deployment, and keeps controls enabled', async () => {
    aiConfig.graphEnabled = false;
    await renderPage();

    expect(
      await screen.findByText(/connected knowledge is turned off on this deployment/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /extract a graph proposal/i })).toBeEnabled();
  });

  it('links to the AI settings when the user has no key', async () => {
    aiConfig.keyConfigured = false;
    await renderPage();

    const link = await screen.findByRole('link', { name: /add your ai provider key/i });
    expect(link).toHaveAttribute('href', '/settings/ai');
  });

  describe('domains', () => {
    const domainSwitch = (name: string) =>
      within(screen.getByRole('region', { name: 'Domains' })).getByRole('switch', { name });

    it('Core is always on, Personal is disabled for a later release', async () => {
      await renderPage();
      await waitFor(() => expect(domainSwitch('Personal')).toBeInTheDocument());

      expect(domainSwitch('Core')).toBeChecked();
      expect(domainSwitch('Core')).toBeDisabled();
      expect(domainSwitch('Work')).toBeChecked();
      expect(domainSwitch('Work')).toBeEnabled();
      expect(domainSwitch('Personal')).not.toBeChecked();
      expect(domainSwitch('Personal')).toBeDisabled();
      expect(screen.getByText('Coming in a later release')).toBeInTheDocument();
    });

    it('turning Work off asks first, and cancel sends nothing', async () => {
      const user = userEvent.setup();
      await renderPage();
      await waitFor(() => expect(domainSwitch('Work')).toBeInTheDocument());

      await user.click(domainSwitch('Work'));
      const dialog = await screen.findByRole('dialog', { name: /turn off work/i });
      expect(
        within(dialog).getByText(/work types won.t be offered to extraction/i),
      ).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(patches).toEqual([]);
      expect(domainSwitch('Work')).toBeChecked();
    });

    it('confirming Work off PATCHes domains.work and reloads the ontology', async () => {
      const user = userEvent.setup();
      let ontologyReads = 0;
      useHandlers();
      server.use(
        http.get(`${API_BASE}/graph/ontology`, () => {
          ontologyReads += 1;
          return HttpResponse.json({
            data: mockGraphOntology(stored.graph?.domains?.work === false ? ['core'] : ['core', 'work']),
          });
        }),
      );
      render(<UserKnowledgeGraphPage />);
      await waitFor(() => expect(domainSwitch('Work')).toBeInTheDocument());
      const before = ontologyReads;

      await user.click(domainSwitch('Work'));
      const dialog = await screen.findByRole('dialog', { name: /turn off work/i });
      await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));

      await waitFor(() => expect(patches).toEqual([{ graph: { domains: { work: false } } }]));
      await waitFor(() => expect(ontologyReads).toBeGreaterThan(before));
      await waitFor(() => expect(domainSwitch('Work')).not.toBeChecked());
    });

    it('turning Work back on needs no confirmation', async () => {
      const user = userEvent.setup();
      await renderPage({ domains: { work: false, personal: false } });
      await waitFor(() => expect(domainSwitch('Work')).not.toBeChecked());

      await user.click(domainSwitch('Work'));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(patches).toEqual([{ graph: { domains: { work: true } } }]));
    });
  });

  it('shows "Not saved" and the reason when a save fails', async () => {
    const user = userEvent.setup();
    await renderPage();
    server.use(
      http.patch(`${API_BASE}/user-settings`, () =>
        HttpResponse.json(
          { code: 'BAD_REQUEST', message: 'graph.resolution: newThreshold must be at least 0.05 below autoLinkThreshold' },
          { status: 400 },
        ),
      ),
    );

    await user.click(screen.getByRole('switch', { name: /extract a graph proposal/i }));

    expect(await screen.findByText('Not saved')).toBeInTheDocument();
    expect(screen.getByText(/newThreshold must be at least 0.05 below/i)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = await renderPage();
    await screen.findByText('No attributes of your own yet.');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
