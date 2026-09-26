import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { ExtractDialog } from '../../../components/graph/guide/ExtractDialog';
import { forgetEntityLabels, rememberEntityLabel } from '../../../components/graph/guide/guidance';
import { invalidateGraphOntology } from '../../../hooks/useGraphOntology';
import {
  EXISTING_SARAH_ID,
  mockExtractEstimate,
  mockGraphAiConfig,
  proposalMock,
} from '../../mocks/graphData';
import { server } from '../../mocks/server';
import { setViewportWidth } from '../../setup';
import { mockAdminUser, render } from '../../utils/test-utils';
import type { MockUser } from '../../utils/test-utils';

const API = '*/api';
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const graphUser: MockUser = {
  ...mockAdminUser,
  permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'],
};

let estimateRequests: Array<string | null>;
let estimate = mockExtractEstimate();

beforeEach(() => {
  invalidateGraphOntology();
  forgetEntityLabels();
  proposalMock.reset(null);
  estimateRequests = [];
  estimate = mockExtractEstimate();
  server.use(
    http.get(`${API}/ai/config`, () => HttpResponse.json({ data: mockGraphAiConfig() })),
    http.get(`${API}/graph/extract/estimate`, ({ request }) => {
      estimateRequests.push(new URL(request.url).searchParams.get('model'));
      return HttpResponse.json({ data: estimate });
    }),
  );
});

function renderDialog(props: Partial<Parameters<typeof ExtractDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onStarted = vi.fn();
  const utils = render(
    <ExtractDialog open onClose={onClose} noteId="n1" mode="extract" onStarted={onStarted} {...props} />,
    { wrapperOptions: { user: graphUser } },
  );
  return { ...utils, onClose, onStarted };
}

async function estimated() {
  await screen.findByText(/input tokens/);
}

function extractBody() {
  const matches = proposalMock.requests.filter((request) => request.path.endsWith('/extract'));
  return matches[matches.length - 1]?.body;
}

function conflict(reason: string, extra: Record<string, unknown> = {}) {
  return HttpResponse.json(
    { statusCode: 409, message: 'Refused', details: { reason, ...extra } },
    { status: 409 },
  );
}

describe('ExtractDialog — model and estimate', () => {
  it("defaults to the admin's task model and lists only structured-output models", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();
    const select = await screen.findByRole('combobox', { name: 'Model' });
    expect(select).toHaveTextContent('GPT-4.1');
    expect(screen.getByText(/Runs on your own AI key/)).toBeInTheDocument();
    await estimated();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    await user.click(select);
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'GPT-4o mini',
      'GPT-4.1',
    ]);
  });

  it('shows the estimate and re-estimates after a model change (debounced)', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(await screen.findByText('About 4,200 input tokens · 1 request')).toBeInTheDocument();
    expect(estimateRequests).toEqual(['gpt-4.1']);
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(await screen.findByRole('option', { name: 'GPT-4o mini' }));
    await waitFor(() => expect(estimateRequests).toEqual(['gpt-4.1', 'gpt-4o-mini']));
  });

  it('blocks Extract when the prompt does not fit', async () => {
    estimate = mockExtractEstimate({ fits: false, inputTokens: 140_000, availableInputTokens: 100_000 });
    renderDialog();
    expect(await screen.findByText(/This note is too long for GPT-4.1: about 140,000 tokens against a limit of 100,000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Extract' })).toBeDisabled();
  });

  it('blocks Extract without a key and links to the key page', async () => {
    estimate = mockExtractEstimate({ keyConfigured: false });
    renderDialog();
    const link = await screen.findByRole('link', { name: 'Add your AI key' });
    expect(link).toHaveAttribute('href', '/settings/ai');
    expect(screen.getByRole('button', { name: 'Extract' })).toBeDisabled();
  });
});

describe('ExtractDialog — request body', () => {
  it('sends {} for the default model and no guidance', async () => {
    const user = userEvent.setup();
    const { onStarted, onClose } = renderDialog();
    await estimated();
    await user.click(screen.getByRole('button', { name: 'Extract' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.any(String)));
    expect(extractBody()).toEqual({});
    expect(onClose).toHaveBeenCalled();
  });

  it('sends the chosen model and normalized guidance', async () => {
    const user = userEvent.setup();
    const { onStarted } = renderDialog();
    await estimated();
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(await screen.findByRole('option', { name: 'GPT-4o mini' }));
    await user.click(screen.getByRole('button', { name: 'Guide the graph' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Claim' }));
    await user.type(screen.getByRole('textbox', { name: 'Instructions' }), '  Only the vendor migration  ');
    await screen.findByText(/input tokens/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Extract' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Extract' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(extractBody()).toEqual({
      model: 'gpt-4o-mini',
      userGuidance: {
        pinnedEntityIds: [],
        instructions: 'Only the vendor migration',
        entityTypes: ['Person', 'Organization', 'PersonFact', 'Project', 'Commitment', 'Decision'],
      },
    });
  });

  it('pre-fills from the latest guidance, expanded, and keeps it on re-extract', async () => {
    rememberEntityLabel(EXISTING_SARAH_ID, 'Sarah Chen');
    const user = userEvent.setup();
    const { onStarted } = renderDialog({
      mode: 're-extract',
      pendingDecisions: 3,
      initialGuidance: { pinnedEntityIds: [EXISTING_SARAH_ID], instructions: 'Sam is our CTO' },
    });
    expect(screen.getByRole('heading', { name: 'Extract again' })).toBeInTheDocument();
    expect(
      screen.getByText("You've decided 3 rows on the current draft. A new draft replaces it once it's ready."),
    ).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Instructions' })).toHaveValue('Sam is our CTO');
    expect(screen.getByRole('button', { name: /Sarah Chen/ })).toBeInTheDocument();
    await estimated();
    await user.click(screen.getByRole('button', { name: 'Extract again' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(extractBody()).toEqual({
      userGuidance: { pinnedEntityIds: [EXISTING_SARAH_ID], instructions: 'Sam is our CTO' },
    });
  });
});

describe('ExtractDialog — refusals', () => {
  it.each([
    ['extraction_running', 'An extraction is already running for this note.'],
    ['model_lacks_capability', "This model can't produce structured output — choose another."],
    ['graph_disabled', 'Connected knowledge is switched off on this deployment.'],
    ['ai_not_configured', 'AI is not set up on this deployment yet. Ask your administrator.'],
    ['note_not_ready', 'This note is still being written. Extract it once it is ready.'],
  ])('409 %s', async (reason, copy) => {
    server.use(http.post(`${API}/graph/notes/:noteId/extract`, () => conflict(reason)));
    const user = userEvent.setup();
    const { onStarted } = renderDialog();
    await estimated();
    await user.click(screen.getByRole('button', { name: 'Extract' }));
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('409 ai_key_missing links to the key page', async () => {
    server.use(http.post(`${API}/graph/notes/:noteId/extract`, () => conflict('ai_key_missing')));
    const user = userEvent.setup();
    renderDialog();
    await estimated();
    await user.click(screen.getByRole('button', { name: 'Extract' }));
    const alert = await screen.findByText(/You have no AI key for this provider/);
    expect(within(alert).getByRole('link', { name: 'Add your AI key' })).toHaveAttribute('href', '/settings/ai');
  });

  it('400 unknown types and invalid pins are highlighted in the panel', async () => {
    rememberEntityLabel(EXISTING_SARAH_ID, 'Sarah Chen');
    server.use(
      http.post(`${API}/graph/notes/:noteId/extract`, () =>
        HttpResponse.json(
          {
            statusCode: 400,
            message: 'Invalid guidance',
            details: { unknownTypes: ['Claim'], invalidPinnedIds: [EXISTING_SARAH_ID] },
          },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderDialog({ initialGuidance: { pinnedEntityIds: [EXISTING_SARAH_ID], instructions: '' } });
    await estimated();
    await user.click(screen.getByRole('button', { name: 'Extract' }));
    expect(await screen.findByText(/Some of your guidance no longer matches your graph/)).toBeInTheDocument();
    expect(screen.getByText('Sarah Chen (no longer in your graph)')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Claim' }).className).toMatch(/colorError/);
  });

  it('400 model_not_permitted is shown on the model field', async () => {
    server.use(
      http.post(`${API}/graph/notes/:noteId/extract`, () =>
        HttpResponse.json(
          { statusCode: 400, message: 'Not permitted', details: { reason: 'model_not_permitted' } },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    await estimated();
    await user.click(screen.getByRole('button', { name: 'Extract' }));
    expect(await screen.findByText("That model isn't permitted on this deployment")).toBeInTheDocument();
  });
});

describe('ExtractDialog — phone', () => {
  it('is full screen below sm', async () => {
    setViewportWidth(390);
    const { container } = renderDialog();
    await estimated();
    expect(document.querySelector('.MuiDialog-paperFullScreen')).not.toBeNull();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
