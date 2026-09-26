import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../mocks/server';
import { render } from '../utils/test-utils';
import type { MockUser } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import { graphReader, graphWriter } from '../utils/graphTestUsers';
import {
  ACME_ID,
  JOE_ID,
  SENSITIVE_FACT_STATEMENT,
  briefFixture,
  entityDetail,
  neighborhoodFixture,
  timelineFixture,
} from '../mocks/graphData';
import GraphEntityPage from '../../pages/GraphEntityPage';
import GraphIndexPage from '../../pages/GraphIndexPage';
import { BRIEF_SECTION_TITLES, DIGEST_UNAVAILABLE_COPY } from '../../components/graph/EntityBriefCard';
import { buildEntityPatch, issuesToFieldErrors } from '../../components/graph/EntityEditDialog';
import { clearEvidenceCache } from '../../hooks/useGraphEvidence';
import type { DigestUnavailableReason, EntityBrief } from '../../services/graph';

/**
 * `/graph/entities/:id` — "everything about Joe" (#373), against MSW fixtures
 * mirroring #370's read API and #372's brief.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

/** Every request the page made, method + path + query. */
let requests: { method: string; url: URL }[];

beforeEach(() => {
  clearEvidenceCache();
  requests = [];
  server.events.removeAllListeners();
  server.events.on('request:start', ({ request }) => {
    requests.push({ method: request.method, url: new URL(request.url) });
  });
});

function renderEntity(id = JOE_ID, user: MockUser = graphWriter) {
  return render(
    <Routes>
      <Route path="/graph/entities/:id" element={<GraphEntityPage />} />
      <Route path="/graph" element={<GraphIndexPage />} />
    </Routes>,
    { wrapperOptions: { route: `/graph/entities/${id}`, user } },
  );
}

function useBrief(brief: EntityBrief) {
  server.use(http.get('*/api/graph/entities/:id/brief', () => HttpResponse.json({ data: brief })));
}

async function pageReady() {
  await screen.findByRole('heading', { level: 1, name: 'Joe Rivera' });
  await screen.findByRole('heading', { level: 2, name: 'Brief' });
}

describe('GraphEntityPage — header', () => {
  it('renders the type, label, aliases, dates and counts', async () => {
    const { container } = renderEntity();
    await pageReady();

    expect(screen.getByText('Person')).toBeInTheDocument();
    const aliases = screen.getByRole('list', { name: 'Also known as' });
    expect(within(aliases).getByText('Joseph Rivera')).toBeInTheDocument();
    expect(screen.getByText(/14 mentions · 5 connections · 2 open commitments/)).toBeInTheDocument();

    await screen.findByRole('heading', { level: 2, name: 'Timeline' });
    await screen.findByText('Works for');
    await waitFor(() => expect(screen.queryAllByRole('status', { name: /Loading/ })).toHaveLength(0));
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('caps the alias chips at five with a "+n"', async () => {
    server.use(
      http.get('*/api/graph/entities/:id', () =>
        HttpResponse.json({
          data: entityDetail(JOE_ID, {
            aliases: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((alias, index) => ({
              id: `00000000-0000-4000-8000-00000000009${index}`,
              alias,
              source: 'user' as const,
            })),
          }),
        }),
      ),
    );
    renderEntity();
    await pageReady();
    expect(screen.getByRole('listitem', { name: '2 more names' })).toHaveTextContent('+2');
    expect(screen.queryByText('F')).not.toBeInTheDocument();
  });

  it('shows Edit only with graph:write', async () => {
    renderEntity(JOE_ID, graphReader);
    await pageReady();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /More actions for/ })).not.toBeInTheDocument();
  });

  it('answers a 404 with its own state and no Retry', async () => {
    renderEntity('00000000-0000-4000-8000-000000009999');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    expect(screen.getByText(/does not exist, or you no longer have access to it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Knowledge' })).toHaveAttribute('href', '/graph');
  });

  it('offers Retry on any other failure', async () => {
    server.use(
      http.get('*/api/graph/entities/:id', () => HttpResponse.json({ message: 'Boom' }, { status: 500 })),
    );
    renderEntity();
    expect(await screen.findByText('Boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('GraphEntityPage — edit', () => {
  it('generates the form from the ontology and sends only what changed', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    server.use(
      http.patch('*/api/graph/entities/:id', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: { id: JOE_ID } });
      }),
    );
    renderEntity();
    await pageReady();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Joe Rivera/ });

    // "Job title" is Person's attribute in the shipped ontology — no per-type code.
    const jobTitle = within(dialog).getByRole('textbox', { name: 'Job title' });
    expect(jobTitle).toHaveValue('VP Engineering');

    const name = within(dialog).getByRole('textbox', { name: /Name/ });
    await user.clear(name);
    await user.type(name, 'Joseph Rivera');
    await user.type(within(dialog).getByRole('textbox', { name: 'Add another name' }), 'JR{Enter}');

    const entityReads = requests.filter((r) => r.url.pathname.endsWith(`/entities/${JOE_ID}`)).length;
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(body).toEqual({ label: 'Joseph Rivera', addAliases: ['JR'] });
    // Success refreshes the entity and the brief (the latter without marking a view).
    await waitFor(() =>
      expect(requests.filter((r) => r.url.pathname.endsWith(`/entities/${JOE_ID}`)).length).toBeGreaterThan(entityReads),
    );
    const briefReads = requests.filter((r) => r.url.pathname.endsWith('/brief'));
    expect(briefReads.at(-1)?.url.searchParams.get('markViewed')).toBe('false');
  });

  it('shows a save error inline and keeps the dialog open', async () => {
    const user = userEvent.setup();
    server.use(
      http.patch('*/api/graph/entities/:id', () =>
        HttpResponse.json(
          { message: 'Some attributes are not valid for this type.', details: { issues: [{ path: 'title', message: 'Too long' }] } },
          { status: 400 },
        ),
      ),
    );
    renderEntity();
    await pageReady();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const jobTitle = within(dialog).getByRole('textbox', { name: 'Job title' });
    await user.type(jobTitle, '!');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('Some attributes are not valid for this type.')).toBeInTheDocument();
    expect(within(dialog).getByText('Too long')).toBeInTheDocument();
  });

  it('shows a 409 inline', async () => {
    const user = userEvent.setup();
    server.use(
      http.patch('*/api/graph/entities/:id', () =>
        HttpResponse.json({ message: 'This entity was merged.', details: { reason: 'entity_merged' } }, { status: 409 }),
      ),
    );
    renderEntity();
    await pageReady();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Add another name' }), 'Joey{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('This entity was merged.')).toBeInTheDocument();
  });

  it('is full-screen on a phone', async () => {
    const user = userEvent.setup();
    setViewportWidth(390);
    renderEntity();
    await pageReady();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.className).toMatch(/fullScreen/i);
  });

  it('buildEntityPatch clears a removed prop with null and diffs aliases', () => {
    const entity = entityDetail(JOE_ID);
    expect(
      buildEntityPatch(entity, {
        label: entity.label,
        props: { title: '' },
        addAliases: [' ', 'Jo'],
        removeAliasIds: [entity.aliases[0].id],
      }),
    ).toEqual({ props: { title: null }, addAliases: ['Jo'], removeAliasIds: [entity.aliases[0].id] });
    expect(buildEntityPatch(entity, { label: entity.label, props: entity.props, addAliases: [], removeAliasIds: [] })).toEqual({});
  });

  it('issuesToFieldErrors keeps the first message per top-level key', () => {
    expect(
      issuesToFieldErrors({ issues: [{ path: 'topics.2', message: 'a' }, { path: 'topics', message: 'b' }, { path: ['website'], message: 'c' }] }),
    ).toEqual({ topics: 'a', website: 'c' });
    expect(issuesToFieldErrors(undefined)).toEqual({});
  });
});

describe('GraphEntityPage — forget', () => {
  it('requires typing FORGET, posts #357 body and lands on /graph with a snackbar', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    server.use(
      http.post('*/api/graph/entities/:id/forget', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          { data: { jobId: 'job-1', entityId: JOE_ID, status: 'pending' } },
          { status: 202 },
        );
      }),
    );
    renderEntity();
    await pageReady();

    await user.click(screen.getByRole('button', { name: 'More actions for Joe Rivera' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Forget this person…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Forget Joe Rivera?' });
    expect(within(dialog).getByText(/Your recordings and notes are not changed/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Forget this person' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Type FORGET to confirm' }), 'FORGET');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    expect(body).toEqual({ confirmation: 'FORGET' });
    expect(await screen.findByText('Forgetting Joe Rivera… this takes a few seconds')).toBeInTheDocument();
  });

  it('is not offered for a non-Person', async () => {
    renderEntity(ACME_ID);
    await screen.findByRole('heading', { level: 1, name: 'Acme Corp' });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /More actions for/ })).not.toBeInTheDocument();
  });
});

describe('GraphEntityPage — brief', () => {
  it('renders the five sections in spec order, with numbered evidence chips', async () => {
    renderEntity();
    await pageReady();

    const brief = screen.getByRole('region', { name: 'Brief' });
    const sectionButtons = within(brief)
      .getAllByRole('button', { expanded: true })
      .map((button) => button.textContent ?? '');
    const order = BRIEF_SECTION_TITLES.map((title) =>
      sectionButtons.findIndex((text) => text.startsWith(title)),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(within(brief).getByText('Theirs')).toBeInTheDocument();
    expect(within(brief).getByText('Yours')).toBeInTheDocument();
    expect(within(brief).getByText('Superseded')).toBeInTheDocument();
    // The promotion: one ended + one started HAS_ROLE.
    expect(within(brief).getByText(/ended has role “Director of Engineering”/)).toBeInTheDocument();
    expect(within(brief).getByText(/started has role “VP Engineering”/)).toBeInTheDocument();

    expect(
      (await within(brief).findAllByRole('button', { name: /^Source 1: Q3 planning call$/ })).length,
    ).toBeGreaterThan(0);
  });

  it('says "since you last looked" only for a last-viewed window', async () => {
    renderEntity();
    await pageReady();
    expect(screen.getByText(/— since you last looked/)).toBeInTheDocument();
  });

  it('omits the suffix for any other window source', async () => {
    useBrief(briefFixture({ window: { since: '2026-08-27T00:00:00.000Z', sinceSource: 'default', asOf: '2026-09-26T00:00:00.000Z', lastViewedAt: null } }));
    renderEntity();
    await pageReady();
    expect(screen.getByText(/^Since /)).toBeInTheDocument();
    expect(screen.queryByText(/since you last looked/)).not.toBeInTheDocument();
  });

  it('marks the view on the first read only', async () => {
    renderEntity();
    await pageReady();
    const briefReads = requests.filter((r) => r.url.pathname.endsWith('/brief'));
    expect(briefReads[0].url.searchParams.get('markViewed')).toBe('true');
  });

  it('shows the stored digest with its date, and never asks for anything but GETs', async () => {
    renderEntity();
    await pageReady();
    expect(screen.getByText('Joe was promoted to VP Engineering in September.')).toBeInTheDocument();
    expect(screen.getByText(/Summary as of/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Write summary/i })).not.toBeInTheDocument();

    await screen.findByText('Works for');
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    const briefPaths = new Set(
      requests.filter((r) => r.url.pathname.includes('/brief')).map((r) => r.url.pathname),
    );
    expect([...briefPaths]).toEqual([`/api/graph/entities/${JOE_ID}/brief`]);
  });

  it('says "Updating summary…" while a digest is pending', async () => {
    useBrief(briefFixture({ digestPending: true, digestStale: true }));
    renderEntity();
    await pageReady();
    expect(screen.getByText('Updating summary…')).toBeInTheDocument();
  });

  it.each(Object.entries(DIGEST_UNAVAILABLE_COPY) as [DigestUnavailableReason, string][])(
    'explains why a stale digest is not refreshing: %s',
    async (reason, copy) => {
      useBrief(briefFixture({ digestStale: true, digestPending: false, digestUnavailable: reason }));
      renderEntity();
      await pageReady();
      const text = await screen.findByText(copy);
      if (reason === 'ai_key_missing') {
        expect(text.closest('a')).toHaveAttribute('href', '/settings/ai');
      }
      expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    },
  );

  it('offers Refresh after a failed refresh, which re-reads without marking a view', async () => {
    const user = userEvent.setup();
    useBrief(briefFixture({ digestStale: true, digestPending: false, digestUnavailable: null }));
    renderEntity();
    await pageReady();

    expect(screen.getByText('Summary may be out of date')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(requests.filter((r) => r.url.pathname.endsWith('/brief'))).toHaveLength(2));
    const last = requests.filter((r) => r.url.pathname.endsWith('/brief')).at(-1);
    expect(last?.url.searchParams.get('markViewed')).toBe('false');
  });

  it('omits the Summary when there is no digest and nothing coming', async () => {
    useBrief(briefFixture({ digest: null, digestStale: true, digestPending: false, digestUnavailable: null }));
    renderEntity();
    await pageReady();
    expect(screen.queryByRole('heading', { name: 'Summary' })).not.toBeInTheDocument();
  });

  it('renders related snippets with <mark> only, linking to the source', async () => {
    renderEntity();
    await pageReady();
    const related = screen.getByRole('region', { name: 'Related' });
    const link = within(related).getByRole('link', { name: 'Q3 planning call' });
    expect(link.getAttribute('href')).toMatch(/\?t=754000$/);
    expect(within(related).getByText('Atlas').tagName).toBe('MARK');
    // Escaped entities come through as text, never markup.
    expect(within(related).getByText(/beta & review hiring/)).toBeInTheDocument();
  });
});

describe('GraphEntityPage — connections', () => {
  it('groups by edge type, naming incoming edges from the entity', async () => {
    renderEntity();
    await pageReady();
    const section = await screen.findByRole('region', { name: 'Connections' });

    expect(await within(section).findByRole('heading', { name: 'Works for' })).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'Acme Corp' })).toHaveAttribute('href', `/graph/entities/${ACME_ID}`);
    const attended = within(section).getByRole('heading', { name: 'Attended' });
    expect(attended.nextElementSibling?.querySelectorAll('li')).toHaveLength(2);
    // The item is the SOURCE of ASSIGNED_TO, so the group reads from Joe's side.
    expect(within(section).getByRole('heading', { name: 'Assigned to Joe Rivera' })).toBeInTheDocument();
    expect(requests.find((r) => r.url.pathname.endsWith('/neighborhood'))?.url.searchParams.get('limit')).toBe('100');
  });

  it('links to the explorer when the slice was truncated', async () => {
    server.use(
      http.get('*/api/graph/entities/:id/neighborhood', () =>
        HttpResponse.json({ data: neighborhoodFixture({ truncated: true }) }),
      ),
    );
    renderEntity();
    await pageReady();
    const link = await screen.findByRole('link', { name: 'open in Explorer' });
    expect(link).toHaveAttribute('href', `/graph/explore?seed=${JOE_ID}`);
  });
});

describe('GraphEntityPage — timeline', () => {
  it('groups by month with precision-aware dates and marks superseded items', async () => {
    renderEntity();
    await pageReady();
    const section = await screen.findByRole('region', { name: 'Timeline' });
    await within(section).findByRole('heading', { name: 'September 2026' });
    expect(within(section).getByRole('heading', { name: 'June 2026' })).toBeInTheDocument();
    expect(within(section).getByRole('heading', { name: '2025' })).toBeInTheDocument();
    expect(within(section).getByText('20 Sep 2026')).toBeInTheDocument();
    expect(within(section).getAllByText('Sep 2026').length).toBeGreaterThan(0);
    expect(within(section).getByText('Superseded')).toBeInTheDocument();
  });

  it('hides sensitive facts until the switch is turned on, then asks again', async () => {
    const user = userEvent.setup();
    renderEntity();
    await pageReady();
    const section = await screen.findByRole('region', { name: 'Timeline' });
    await within(section).findByRole('heading', { name: 'September 2026' });

    expect(screen.queryByText(SENSITIVE_FACT_STATEMENT)).not.toBeInTheDocument();
    const firstRead = requests.find((r) => r.url.pathname.endsWith('/timeline'));
    expect(firstRead?.url.searchParams.get('includeSensitive')).toBeNull();

    await user.click(within(section).getByRole('switch', { name: 'Show sensitive facts' }));

    expect(await within(section).findByText(SENSITIVE_FACT_STATEMENT)).toBeInTheDocument();
    expect(within(section).getAllByText('Sensitive').length).toBeGreaterThan(0);
    expect(requests.filter((r) => r.url.pathname.endsWith('/timeline')).at(-1)?.url.searchParams.get('includeSensitive')).toBe('true');
    // The brief never shows it.
    expect(within(screen.getByRole('region', { name: 'Brief' })).queryByText(SENSITIVE_FACT_STATEMENT)).not.toBeInTheDocument();
  });

  it('pages with Load more', async () => {
    const user = userEvent.setup();
    const events = timelineFixture();
    server.use(
      http.get('*/api/graph/entities/:id/timeline', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return HttpResponse.json({
          data: cursor
            ? { items: events.slice(2), nextCursor: null, asOf: '2026-09-26T00:00:00.000Z' }
            : { items: events.slice(0, 2), nextCursor: 'tl-2', asOf: '2026-09-26T00:00:00.000Z' },
        });
      }),
    );
    renderEntity();
    await pageReady();
    const section = await screen.findByRole('region', { name: 'Timeline' });
    await within(section).findByRole('heading', { name: 'September 2026' });
    expect(within(section).queryByRole('heading', { name: '2025' })).not.toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: 'Load more' }));
    expect(await within(section).findByRole('heading', { name: '2025' })).toBeInTheDocument();
  });
});

describe('GraphEntityPage — mentions', () => {
  it('lists mentions and disables the ones no longer available', async () => {
    renderEntity();
    await pageReady();
    const section = await screen.findByRole('region', { name: 'Mentions' });
    const note = await within(section).findByRole('link', { name: /Q3 planning — decisions/ });
    expect(note.getAttribute('href')).toMatch(/^\/notes\//);
    const gone = within(section).getByRole('button', { name: /No longer available/ });
    expect(gone).toHaveAttribute('aria-disabled', 'true');
  });
});
