/**
 * `AiTasksSettingsSections` — the app's sections of `/admin/settings/ai`
 * (issue #477, epic #472): connected knowledge, task models, and the default
 * model and ceilings, sharing one draft and one Save over
 * `GET|PUT /api/ai-tasks/settings`.
 *
 * The service module is partly mocked (only the network calls), so the real
 * constants and the `If-Match` version the hook attaches are exercised. `usePermissions` is mocked to flip `ai_config:write`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { AI_CONFIG_DISABLED, AiConfigContext } from '@marinoscar/platform-web/ai/headless';

vi.mock('../../../services/aiTasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/aiTasks')>();
  return {
    ...actual,
    getAiTasksSettings: vi.fn(),
    putAiTasksSettings: vi.fn(),
  };
});

vi.mock('@marinoscar/platform-web/identity/headless', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/identity/headless')>()),
  usePermissions: vi.fn(),
}));

// A save re-reads the navigation features (the `knowledge` destination follows
// `graphEnabled`). Mocked so a save's effect on it is asserted directly.
const mockRefreshNavigationFeatures = vi.fn();
vi.mock('../../../contexts/NavigationFeaturesContext', () => ({
  useNavigationFeatures: () => ({
    features: { graph: false },
    refresh: mockRefreshNavigationFeatures,
  }),
}));

import { render, mockAdminUser } from '../../utils/test-utils';
import { AiTasksSettingsSections } from '../../../components/admin/AiTasksSettingsSections';
import { usePermissions } from '@marinoscar/platform-web/identity/headless';
import { getAiTasksSettings, putAiTasksSettings } from '../../../services/aiTasks';
import type { AiTasksSettings } from '../../../services/aiTasks';
import { mockAiTasksSettingsView, mockTaskModelStatus } from '../../mocks/aiTasks';
import { ApiError } from '../../../services/api';

const mockUsePermissions = vi.mocked(usePermissions);
const mockGetSettings = vi.mocked(getAiTasksSettings);
const mockPut = vi.mocked(putAiTasksSettings);

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const WRITE = ['ai_config:read', 'ai_config:write'];
const READ_ONLY = ['ai_config:read'];

function setPermissions(granted: string[]) {
  mockUsePermissions.mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(['admin']),
    hasPermission: (permission: string) => granted.includes(permission),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: true,
  });
}

function view(overrides: Partial<AiTasksSettings> = {}, version = 7) {
  return mockAiTasksSettingsView(overrides, version);
}

function renderSections(options: { aiEnabled?: boolean } = {}) {
  const config = { ...AI_CONFIG_DISABLED, enabled: options.aiEnabled ?? true };
  return render(
    <AiConfigContext.Provider
      value={{ config, isLoading: false, error: null, refresh: async () => {} }}
    >
      <AiTasksSettingsSections />
    </AiConfigContext.Provider>,
    { wrapperOptions: { user: mockAdminUser } },
  );
}

async function loaded() {
  await screen.findByRole('heading', { level: 2, name: 'Task models' });
}

const saveButton = () => screen.getByRole('button', { name: /save task settings|saving/i });

beforeEach(() => {
  vi.clearAllMocks();
  setPermissions(WRITE);
  mockGetSettings.mockResolvedValue(view());
});

describe('AiTasksSettingsSections', () => {
  it('renders the three sections in order, filled from the document', async () => {
    renderSections();
    await loaded();

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      'Tasks and limits',
      'Connected knowledge',
      'Task models',
      'Limits and default model',
    ]);

    expect(screen.getByRole('switch', { name: /enable connected knowledge/i })).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Default model' })).toHaveTextContent('GPT-4o (gpt-4o)');
    expect(screen.getByLabelText('Request timeout (ms)')).toHaveValue(600000);
    // One row per task, with the built-in copy.
    expect(screen.getByTestId('task-model-row-graph.extract')).toBeInTheDocument();
    expect(screen.getByTestId('task-model-row-graph.agent')).toBeInTheDocument();
    expect(screen.getByText('Graph extraction')).toBeInTheDocument();
  });

  it('shows a spinner while loading and an error when the document cannot be read', async () => {
    mockGetSettings.mockRejectedValue(new ApiError('Nope', 403));
    renderSections();

    expect(screen.getByLabelText('Loading AI task settings')).toBeInTheDocument();
    expect(await screen.findByText('You do not have permission to manage AI settings')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Task models' })).toBeNull();
  });

  it('saves the whole document with the loaded version, then refreshes the shell', async () => {
    const user = userEvent.setup();
    mockPut.mockResolvedValue(view({ graphEnabled: true }, 8));
    renderSections();
    await loaded();

    await user.click(screen.getByRole('switch', { name: /enable connected knowledge/i }));
    await user.click(saveButton());

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut).toHaveBeenCalledWith(
      {
        graphEnabled: true,
        taskModels: {},
        defaultModel: 'gpt-4o',
        maxInputTokens: null,
        maxOutputTokens: null,
        requestTimeoutMs: 600000,
        maxDocumentBytes: 26214400,
        reasoningEffort: 'none',
      },
      7,
    );
    expect(await screen.findByText('AI task settings saved')).toBeInTheDocument();
    expect(mockRefreshNavigationFeatures).toHaveBeenCalledTimes(1);
  });

  it('sends a chosen task model and omits tasks left on Default', async () => {
    const user = userEvent.setup();
    mockPut.mockResolvedValue(view());
    renderSections();
    await loaded();

    await user.click(screen.getByRole('combobox', { name: /^model for graph extraction/i }));
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', { name: 'gpt-4o-mini' }),
    );
    await user.click(saveButton());

    await waitFor(() => expect(mockPut).toHaveBeenCalled());
    expect(mockPut.mock.calls[0][0].taskModels).toEqual({
      'graph.extract': { model: 'gpt-4o-mini' },
    });
  });

  it('sends blank caps as null and typed caps as integers', async () => {
    const user = userEvent.setup();
    mockPut.mockResolvedValue(view());
    renderSections();
    await loaded();

    await user.type(screen.getByLabelText('Max input tokens (optional)'), '5000');
    await user.click(saveButton());

    await waitFor(() => expect(mockPut).toHaveBeenCalled());
    expect(mockPut.mock.calls[0][0]).toMatchObject({
      maxInputTokens: 5000,
      maxOutputTokens: null,
    });
  });

  it('blocks the save, and says why, while a value is out of range', async () => {
    const user = userEvent.setup();
    renderSections();
    await loaded();

    await user.clear(screen.getByLabelText('Request timeout (ms)'));
    await user.type(screen.getByLabelText('Request timeout (ms)'), '5');

    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/save is unavailable until you fix/i)).toBeInTheDocument();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('blocks the save while a task names a model that is no longer enabled', async () => {
    mockGetSettings.mockResolvedValue(view({ taskModels: { 'graph.digest': { model: 'retired-model' } } }));
    renderSections();
    await loaded();

    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/a task using a model that is no longer enabled/i)).toBeInTheDocument();
  });

  it('marks the row a refused save named, and keeps the form editable', async () => {
    const user = userEvent.setup();
    mockPut.mockRejectedValue(
      new ApiError('Model cannot do tool calling', 400, 'BAD_REQUEST', {
        reason: 'model_lacks_capability',
        task: 'graph.agent',
      }),
    );
    renderSections();
    await loaded();

    await user.click(saveButton());

    expect(await screen.findByText('Model cannot do tool calling')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('task-model-row-graph.agent')).getByText(
        /the last save was refused for this task/i,
      ),
    ).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('reloads the document on a stale version and says the form was replaced', async () => {
    const user = userEvent.setup();
    mockPut.mockRejectedValue(new ApiError('Conflict', 409));
    mockGetSettings
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ defaultModel: 'gpt-4o-mini', graphEnabled: true }, 9));
    renderSections();
    await loaded();

    await user.click(saveButton());

    expect(await screen.findByText(/someone else changed the ai settings/i)).toBeInTheDocument();
    // The fields on screen are the colleague's, not the stale draft.
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /enable connected knowledge/i })).toBeChecked(),
    );
    expect(screen.getByRole('combobox', { name: 'Default model' })).toHaveTextContent('gpt-4o-mini');
  });

  it('is read-only without ai_config:write: controls disabled, Save disabled, stated', async () => {
    setPermissions(READ_ONLY);
    renderSections();
    await loaded();

    expect(screen.getByText(/\(read-only\)/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /enable connected knowledge/i })).toBeDisabled();
    expect(screen.getByLabelText('Request timeout (ms)')).toBeDisabled();
    expect(saveButton()).toBeDisabled();
  });

  it('explains that connected knowledge cannot run while AI is off', async () => {
    mockGetSettings.mockResolvedValue(view({ graphEnabled: true }));
    renderSections({ aiEnabled: false });
    await loaded();

    expect(screen.getByText(/ai is switched off above/i)).toBeInTheDocument();
  });

  it('notes a configured task model that the server fell back from', async () => {
    mockGetSettings.mockResolvedValue(
      mockAiTasksSettingsView({ taskModels: { 'graph.digest': { model: 'gpt-3.5' } } }, 7, {
        taskModelStatus: mockTaskModelStatus({
          'graph.digest': { configuredModel: 'gpt-3.5', staleTaskModel: true },
        }),
      }),
    );
    renderSections();
    await loaded();

    expect(
      within(screen.getByTestId('task-model-row-graph.digest')).getByText(
        'Configured model gpt-3.5 is no longer permitted; using the default.',
      ),
    ).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderSections();
    await loaded();

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
