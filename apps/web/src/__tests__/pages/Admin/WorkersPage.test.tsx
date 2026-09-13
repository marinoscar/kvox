/**
 * Admin → Operations → Worker Nodes (`/admin/settings/workers`), issue #271,
 * epic #254.
 *
 * The table's MECHANICS are asserted once for every table in
 * `runDataTableConformanceSuite` and the column contract in
 * `workersTable.test.ts`. What is page-specific, and what this file covers, is
 * everything that could be wrong while both of those are perfectly fine:
 *
 *   * the health pill comes from the API's DERIVED verdict, in both directions,
 *     so the pill and the database cannot disagree;
 *   * stale, offline and disabled are three visibly different things on screen,
 *     not three words in the same grey chip;
 *   * deleting a node says out loud what happens to the work it was holding —
 *     released and requeued, not lost;
 *   * a created credential is shown exactly once, with an explicit copy
 *     affordance, and never appears in the list afterwards;
 *   * revoking is one click from the fleet table and takes effect in the list;
 *   * the permission split: `nodes:read` reaches the page, `nodes:write` is
 *     what puts any control on it;
 *   * the polling wiring (its BEHAVIOUR is asserted against a real
 *     `visibilitychange` in `__tests__/hooks/useWorkerNodes.test.ts`).
 *
 * The hooks are mocked, as `JobsPage.test.tsx` mocks `useJobs`: the fetch layer
 * has its own suite, and driving it through msw here would test the transport
 * twice while making every assertion about the page wait on it.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser, type MockUser } from '../../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';
import { api } from '../../../services/api';
import type {
  NodeCredential,
  NodeCredentialCreated,
  WorkerNode,
} from '../../../services/nodes';

vi.mock('../../../hooks/useWorkerNodes', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useWorkerNodes')>(
    '../../../hooks/useWorkerNodes',
  );
  return {
    ...actual,
    useWorkerNodes: vi.fn(),
    useNodeCredentials: vi.fn(),
    useNodeActions: vi.fn(),
    useVisiblePolling: vi.fn(),
  };
});

import {
  WORKER_NODES_POLL_INTERVAL_MS,
  useNodeActions,
  useNodeCredentials,
  useVisiblePolling,
  useWorkerNodes,
} from '../../../hooks/useWorkerNodes';
import WorkersPage from '../../../pages/Admin/WorkersPage';

const mockUseWorkerNodes = vi.mocked(useWorkerNodes);
const mockUseNodeCredentials = vi.mocked(useNodeCredentials);
const mockUseNodeActions = vi.mocked(useNodeActions);
const mockUseVisiblePolling = vi.mocked(useVisiblePolling);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function node(overrides: Partial<WorkerNode> = {}): WorkerNode {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'worker-a',
    hostname: 'build-box-01',
    platform: 'linux-x64',
    cliVersion: '1.4.0',
    eligibleTypes: ['image.thumbnail'],
    concurrency: 4,
    status: 'online',
    health: 'healthy',
    capabilities: null,
    registeredAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-01-01T11:59:00.000Z',
    owner: { id: 'u1', email: 'ops@example.com', name: 'Ops' },
    jobCounts: { running: 1, pending: 2, succeeded: 30, failed: 3, total: 36 },
    ...overrides,
  };
}

const healthyNode = node();
const staleNode = node({
  id: '22222222-2222-4222-8222-222222222222',
  name: 'worker-stale',
  hostname: 'box-stale',
  health: 'stale',
});
const offlineNode = node({
  id: '33333333-3333-4333-8333-333333333333',
  name: 'worker-offline',
  hostname: 'box-offline',
  status: 'offline',
  health: 'offline',
});
const disabledNode = node({
  id: '44444444-4444-4444-8444-444444444444',
  name: 'worker-disabled',
  hostname: 'box-disabled',
  status: 'disabled',
  // Disabled AND still heartbeating: a real state, and the reason status and
  // health are two columns.
  health: 'healthy',
});

function credential(overrides: Partial<NodeCredential> = {}): NodeCredential {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    name: 'build-box-01',
    tokenPrefix: 'nod_1a2b',
    expiresAt: null,
    lastUsedAt: '2026-01-01T11:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    owner: { id: 'u1', email: 'ops@example.com', name: 'Ops' },
    ...overrides,
  };
}

const activeCredential = credential();
const revokedCredential = credential({
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  name: 'retired-box',
  tokenPrefix: 'nod_9z8y',
  revokedAt: '2026-01-01T09:00:00.000Z',
});

const CREATED: NodeCredentialCreated = {
  token: 'nod_thisisthesecretvalue',
  id: 'cccccccc-0000-4000-8000-000000000003',
  name: 'new-box',
  tokenPrefix: 'nod_thi',
  expiresAt: null,
  createdAt: '2026-01-01T12:00:00.000Z',
};

const mockRefreshNodes = vi.fn();
const mockRefreshCredentials = vi.fn();
const mockRemoveNode = vi.fn();
const mockCreateCredential = vi.fn();
const mockRevokeCredential = vi.fn();

function setNodesState(rows: WorkerNode[] = [healthyNode], error: string | null = null) {
  mockUseWorkerNodes.mockReturnValue({
    nodes: rows,
    isLoading: false,
    error,
    refresh: mockRefreshNodes,
  });
}

function setCredentialsState(
  rows: NodeCredential[] = [activeCredential],
  error: string | null = null,
) {
  mockUseNodeCredentials.mockReturnValue({
    credentials: rows,
    isLoading: false,
    error,
    refresh: mockRefreshCredentials,
  });
}

function setActionsState(overrides: { isWorking?: boolean; error?: string | null } = {}) {
  mockUseNodeActions.mockReturnValue({
    isWorking: overrides.isWorking ?? false,
    error: overrides.error ?? null,
    clearError: vi.fn(),
    removeNode: mockRemoveNode,
    createCredential: mockCreateCredential,
    revokeCredential: mockRevokeCredential,
  });
}

/** An admin holding exactly the permissions named. */
function userWith(permissions: string[]): MockUser {
  return { ...mockAdminUser, permissions };
}

const READ_ONLY = ['nodes:read'];
const READ_WRITE = ['nodes:read', 'nodes:write'];

function renderPage(permissions: string[] = READ_WRITE, width = 1400) {
  setInitialContainerWidth(width);
  return render(<WorkersPage />, { wrapperOptions: { user: userWith(permissions) } });
}

// ---------------------------------------------------------------------------

describe('WorkersPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    // Both tables persist their layout under `user_settings.dataTables`.
    vi.spyOn(api, 'get').mockResolvedValue({ dataTables: {} } as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
    mockRemoveNode.mockResolvedValue(true);
    mockRevokeCredential.mockResolvedValue(true);
    mockCreateCredential.mockResolvedValue(CREATED);
    setNodesState();
    setCredentialsState();
    setActionsState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Reachability
  // =========================================================================

  it('redirects a user without nodes:read away, rather than rendering an empty page', () => {
    renderPage(['jobs:read']);

    expect(
      screen.queryByRole('heading', { level: 1, name: 'Worker Nodes' }),
    ).not.toBeInTheDocument();
  });

  it('renders for a nodes:read holder, and says so when they cannot write', () => {
    renderPage(READ_ONLY);

    expect(screen.getByRole('heading', { level: 1, name: 'Worker Nodes' })).toBeInTheDocument();
    // Stated up front rather than left to be discovered by finding every
    // control missing.
    expect(screen.getByText(/\(read-only\)/)).toBeInTheDocument();
  });

  // =========================================================================
  // Health — the API's verdict, rendered
  // =========================================================================

  describe('health', () => {
    it('renders the API’s derived value even when the heartbeat looks recent', async () => {
      // The stale threshold is a SYSTEM SETTING this app never reads. A page
      // that recomputed health from `lastHeartbeatAt` would call this node
      // healthy and disagree with both the database and the fleet sweep.
      setNodesState([
        node({ lastHeartbeatAt: new Date().toISOString(), health: 'stale' }),
      ]);
      renderPage();

      const pill = await screen.findByTestId(`node-health-${healthyNode.id}`);
      expect(pill).toHaveTextContent('Stale');
    });

    it('renders the API’s derived value even when the heartbeat looks ancient', async () => {
      setNodesState([node({ lastHeartbeatAt: '1999-01-01T00:00:00.000Z', health: 'healthy' })]);
      renderPage();

      const pill = await screen.findByTestId(`node-health-${healthyNode.id}`);
      expect(pill).toHaveTextContent('Healthy');
    });

    it('makes a STALE node visually distinct from an OFFLINE one', async () => {
      setNodesState([staleNode, offlineNode]);
      renderPage();

      const stale = await screen.findByTestId(`node-health-${staleNode.id}`);
      const offline = await screen.findByTestId(`node-health-${offlineNode.id}`);

      expect(stale).toHaveTextContent('Stale');
      expect(offline).toHaveTextContent('Offline');
      // Different palette AND different fill AND different word — colour alone
      // is not an accessible distinction, and this page gets screenshotted.
      expect(stale).toHaveClass('MuiChip-colorWarning');
      expect(stale).toHaveClass('MuiChip-filled');
      expect(offline).not.toHaveClass('MuiChip-colorWarning');
      expect(offline).toHaveClass('MuiChip-outlined');
    });

    it('makes a DISABLED node clearly distinct from both', async () => {
      setNodesState([staleNode, offlineNode, disabledNode]);
      renderPage();

      const disabled = await screen.findByTestId(`node-status-${disabledNode.id}`);
      expect(disabled).toHaveTextContent('Disabled');
      // The only chip on the page in the error palette: a human deliberately
      // took this machine out of the rotation.
      expect(disabled).toHaveClass('MuiChip-colorError');
      expect(await screen.findByTestId(`node-status-${staleNode.id}`)).not.toHaveClass(
        'MuiChip-colorError',
      );
      expect(await screen.findByTestId(`node-status-${offlineNode.id}`)).not.toHaveClass(
        'MuiChip-colorError',
      );
    });

    it('reads disabled-and-healthy as both, because status is not liveness', async () => {
      setNodesState([disabledNode]);
      renderPage();

      expect(await screen.findByTestId(`node-status-${disabledNode.id}`)).toHaveTextContent(
        'Disabled',
      );
      expect(await screen.findByTestId(`node-health-${disabledNode.id}`)).toHaveTextContent(
        'Healthy',
      );
    });

    it('tallies the API’s verdicts in the summary strip rather than deriving its own', async () => {
      setNodesState([healthyNode, staleNode, offlineNode, disabledNode]);
      renderPage();

      const strip = await screen.findByLabelText('Fleet summary');
      expect(within(strip).getByText('Nodes').nextSibling).toHaveTextContent('4');
      expect(within(strip).getByText('Healthy').nextSibling).toHaveTextContent('2');
      expect(within(strip).getByText('Stale').nextSibling).toHaveTextContent('1');
      expect(within(strip).getByText('Offline').nextSibling).toHaveTextContent('1');
      // Counted off `status`, not `health` — the disabled node above is healthy.
      expect(within(strip).getByText('Disabled').nextSibling).toHaveTextContent('1');
    });
  });

  // =========================================================================
  // Deleting a node
  // =========================================================================

  describe('deleting a node', () => {
    async function openDeleteConfirm(user: ReturnType<typeof userEvent.setup>) {
      await user.click(
        await screen.findByRole('button', {
          name: `Delete node for ${healthyNode.name} (${healthyNode.hostname})`,
        }),
      );
      return screen.findByRole('dialog');
    }

    it('warns that in-flight jobs are RELEASED AND REQUEUED, not lost', async () => {
      const user = userEvent.setup();
      renderPage();

      const dialog = await openDeleteConfirm(user);

      expect(within(dialog).getByText(/Delete this worker node\?/i)).toBeInTheDocument();
      // The whole point of this dialog. Without it, an operator staring at a
      // dead machine holding eleven running jobs guesses — and the
      // safe-looking guess leaves exactly the jobs they were trying to unstick
      // pinned to a node that is never coming back.
      expect(within(dialog).getByText(/released and requeued/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/NOT deleted/i)).toBeInTheDocument();
    });

    it('warns that the credential is NOT revoked by deleting the node', async () => {
      const user = userEvent.setup();
      renderPage();

      const dialog = await openDeleteConfirm(user);

      // The API says so explicitly, and an operator who believes otherwise has
      // not actually cut off the machine they think they have.
      expect(
        within(dialog).getByText(/the same token can register a new node/i),
      ).toBeInTheDocument();
    });

    it('does not delete when the dialog is cancelled', async () => {
      const user = userEvent.setup();
      renderPage();

      const dialog = await openDeleteConfirm(user);
      await user.click(within(dialog).getByRole('button', { name: /Cancel/i }));

      expect(mockRemoveNode).not.toHaveBeenCalled();
    });

    it('deletes the row that was clicked once confirmed', async () => {
      const user = userEvent.setup();
      renderPage();

      const dialog = await openDeleteConfirm(user);
      await user.click(within(dialog).getByRole('button', { name: 'Delete node' }));

      await waitFor(() => expect(mockRemoveNode).toHaveBeenCalledWith(healthyNode.id));
    });

    it('offers NO row action at all without nodes:write', async () => {
      renderPage(READ_ONLY);

      await screen.findByText(healthyNode.name);
      // The ARRAY is gated, not a rendered control — so nothing appears in the
      // grid, the tablet expander or the phone card.
      expect(screen.queryByRole('button', { name: /Delete node for/ })).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Credentials — the section, not a second destination
  // =========================================================================

  describe('the node credentials section', () => {
    it('is on THIS page, one click from the fleet table', async () => {
      renderPage();

      // Not a registry card and not a tab: revoking a leaked worker token is an
      // incident-response action, and a card would put two clicks in front of
      // it. See `components/admin/NodeCredentials.tsx`.
      expect(
        await screen.findByRole('heading', { level: 2, name: 'Node Credentials' }),
      ).toBeInTheDocument();
      expect(await screen.findByTestId('admin-node-credentials-table')).toBeInTheDocument();
      expect(await screen.findByTestId('admin-worker-nodes-table')).toBeInTheDocument();
    });

    it('lists credentials masked, with their owner, and never a raw token', async () => {
      renderPage();

      expect(await screen.findByText(/nod_1a2b/)).toBeInTheDocument();
      expect(screen.getAllByText('Ops').length).toBeGreaterThan(0);
      expect(screen.queryByText(CREATED.token)).not.toBeInTheDocument();
    });

    it('hides the create button from a reader without nodes:write', async () => {
      renderPage(READ_ONLY);

      await screen.findByText(/nod_1a2b/);
      expect(screen.queryByRole('button', { name: /New credential/i })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Revoke credential for/ }),
      ).not.toBeInTheDocument();
    });

    // ---------------------------------------------------------------------
    // Create → reveal, exactly once
    // ---------------------------------------------------------------------

    it('creates a credential with NO expiry by default, and shows the token once with a copy control', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: /New credential/i }));
      const createDialog = await screen.findByRole('dialog');
      await user.type(
        within(createDialog).getByRole('textbox', { name: /Credential name/i }),
        'new-box',
      );
      await user.click(within(createDialog).getByRole('button', { name: /Create credential/i }));

      // "Never expires" is the intended default for an unattended worker, and
      // the ABSENCE of the field is what the API reads as "no expiry".
      await waitFor(() => expect(mockCreateCredential).toHaveBeenCalledWith({ name: 'new-box' }));

      const reveal = await screen.findByRole('dialog', {});
      expect(within(reveal).getByDisplayValue(CREATED.token)).toBeInTheDocument();
      // An EXPLICIT copy affordance, not just selectable text: dragging to
      // select a 40-character token is where half of one gets copied.
      expect(
        within(reveal).getByRole('button', { name: /copy node credential/i }),
      ).toBeInTheDocument();
      expect(within(reveal).getByText(/cannot be retrieved again/i)).toBeInTheDocument();
    });

    it('sends `expiresInDays` only when the operator chooses an expiry', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: /New credential/i }));
      const createDialog = await screen.findByRole('dialog');
      await user.type(
        within(createDialog).getByRole('textbox', { name: /Credential name/i }),
        'temp-box',
      );
      await user.click(within(createDialog).getByRole('radio', { name: /Expires after/i }));
      await user.click(within(createDialog).getByRole('button', { name: /Create credential/i }));

      await waitFor(() =>
        expect(mockCreateCredential).toHaveBeenCalledWith({ name: 'temp-box', expiresInDays: 90 }),
      );
    });

    it('refuses a whitespace-only name locally, without calling the API', async () => {
      // The field is `required`, so the browser already stops an EMPTY submit.
      // A name of spaces gets past that and would reach the server's
      // `z.string().trim().min(1)` as a 400 — caught here instead, next to the
      // field, with the schema's own bound.
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: /New credential/i }));
      const createDialog = await screen.findByRole('dialog');
      await user.type(
        within(createDialog).getByRole('textbox', { name: /Credential name/i }),
        '   ',
      );
      await user.click(within(createDialog).getByRole('button', { name: /Create credential/i }));

      expect(await within(createDialog).findByText('Name is required')).toBeInTheDocument();
      expect(mockCreateCredential).not.toHaveBeenCalled();
    });

    it('never shows the token again once the reveal dialog is dismissed', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: /New credential/i }));
      const createDialog = await screen.findByRole('dialog');
      await user.type(
        within(createDialog).getByRole('textbox', { name: /Credential name/i }),
        'new-box',
      );
      await user.click(within(createDialog).getByRole('button', { name: /Create credential/i }));

      const reveal = await screen.findByRole('dialog');
      await user.click(within(reveal).getByRole('button', { name: /Done/i }));

      // The server stores only a hash — there is no route that could return it
      // — so the list must not carry it either, and there is nowhere left on
      // the page for it to be.
      await waitFor(() => expect(screen.queryByDisplayValue(CREATED.token)).not.toBeInTheDocument());
      expect(screen.queryByText(CREATED.token)).not.toBeInTheDocument();
    });

    // ---------------------------------------------------------------------
    // Revoke
    // ---------------------------------------------------------------------

    it('confirms, then revokes, and says the node fails on its very next request', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(
        await screen.findByRole('button', {
          name: new RegExp(`Revoke credential for ${activeCredential.name}`),
        }),
      );
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/very next request/i)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));

      await waitFor(() => expect(mockRevokeCredential).toHaveBeenCalledWith(activeCredential.id));
    });

    it('shows an already-revoked credential as Revoked, with its control disabled rather than gone', async () => {
      // This is what "takes effect immediately in the list" looks like once the
      // action's refresh has landed: the same row, re-read, is now inert. The
      // control stays present so the set of actions does not change shape row
      // to row.
      setCredentialsState([activeCredential, revokedCredential]);
      renderPage();

      expect(
        await screen.findByTestId(`credential-status-${revokedCredential.id}`),
      ).toHaveTextContent('Revoked');
      expect(
        await screen.findByTestId(`credential-status-${activeCredential.id}`),
      ).toHaveTextContent('Active');

      expect(
        screen.getByRole('button', {
          name: new RegExp(`Revoke credential for ${revokedCredential.name}`),
        }),
      ).toBeDisabled();
      expect(
        screen.getByRole('button', {
          name: new RegExp(`Revoke credential for ${activeCredential.name}`),
        }),
      ).not.toBeDisabled();
    });
  });

  // =========================================================================
  // Polling
  // =========================================================================

  describe('polling', () => {
    it('polls at the fleet interval, through the shared visible-only helper', () => {
      renderPage();

      expect(mockUseVisiblePolling).toHaveBeenCalledWith(
        expect.any(Function),
        WORKER_NODES_POLL_INTERVAL_MS,
      );
    });

    it('re-reads BOTH the fleet and the credentials on one tick', () => {
      renderPage();

      const tick = mockUseVisiblePolling.mock.calls[0][0];
      tick();

      // One callback for both, so the two tables are never a poll apart — and
      // so a SECOND administrator's revoke shows up here too.
      expect(mockRefreshNodes).toHaveBeenCalledTimes(1);
      expect(mockRefreshCredentials).toHaveBeenCalledTimes(1);
    });

    it('tells the operator the page is live, and on whose authority health is decided', async () => {
      renderPage();

      expect(
        await screen.findByText(
          new RegExp(`re-read every ${WORKER_NODES_POLL_INTERVAL_MS / 1000} seconds`),
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(/Health is derived by the API/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Failure surfaces
  // =========================================================================

  it('surfaces a fleet failure and a credential failure separately', async () => {
    setNodesState([], 'Failed to load worker nodes');
    setCredentialsState([], 'Failed to load node credentials');
    renderPage();

    expect(await screen.findByText('Failed to load worker nodes')).toBeInTheDocument();
    // The credential list stays reachable when the fleet read fails, and vice
    // versa: revoking a token must not be gated behind a fleet query.
    expect(await screen.findByText('Failed to load node credentials')).toBeInTheDocument();
    expect(await screen.findByTestId('admin-node-credentials-table')).toBeInTheDocument();
  });

  it('surfaces a write failure in one banner shared by both halves of the page', async () => {
    setActionsState({ error: 'Failed to revoke node credential' });
    renderPage();

    expect(await screen.findByText('Failed to revoke node credential')).toBeInTheDocument();
  });
});
