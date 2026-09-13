/**
 * Admin → Operations → Worker Nodes (`/admin/settings/workers`).
 *
 * Issue #271, epic #254. A REGISTRY CARD and nothing else, per CLAUDE.md's
 * MANDATORY Settings UI Pattern: one entry in `ADMIN_SECTIONS`
 * (`config/adminSections.tsx`, flipped from `disabled` to a `path` by this
 * issue), one route in `App.tsx` gated on the same permission string the API
 * enforces, and no tab anywhere. The hub, the Console rail and the compact
 * AppBar title all pick this page up from that single declaration.
 *
 * A fleet an operator cannot see is a fleet they cannot trust, and the two
 * questions they actually have are:
 *
 *   1. "Is every worker alive and doing something?" — the fleet table.
 *   2. "Which credentials exist, and can I kill one right now?" — the
 *      credentials section BELOW IT, on this same page.
 *
 * =============================================================================
 * WHY CREDENTIALS ARE A SECTION HERE AND NOT A SECOND REGISTRY CARD
 * =============================================================================
 *
 * Because the second question is an INCIDENT-RESPONSE action and must not
 * require a shell — or, for the same reason, a navigation. CLAUDE.md's rule is
 * that a destination gate is about REACHABILITY and a gate inside a page is
 * about CONTENT; credentials are content of "the machines attached to this
 * deployment". `components/admin/NodeCredentials.tsx` carries the full
 * argument, including the two alternatives that were rejected: a
 * `/admin/settings/nodes/credentials` card (two clicks between "this worker is
 * compromised" and revoking its token), and reusing the Personal Access Tokens
 * page (a different permission, a different audience, and a `nod_` credential
 * is not a PAT — it is confined to `/api/nodes/*` and cannot mint another
 * credential, while a PAT is the user's whole identity).
 *
 * The third alternative, a bespoke table, was rejected here: both tables are
 * `components/datatable`, which is what gives them the phone card layout, the
 * tablet expander, the column picker, the CSV export, the persisted layout and
 * the axe-tested keyboard model for free — and what means the accessibility
 * contract is asserted once, in the shared conformance suite, rather than
 * re-litigated per page.
 *
 * =============================================================================
 * HEALTH IS THE API'S VERDICT. THIS PAGE NEVER DERIVES IT.
 * =============================================================================
 *
 * Every pill reads `node.health`, computed by `deriveNodeHealth` against the
 * `nodes.staleHeartbeatSeconds` system setting at read time. The summary strip
 * TALLIES those verdicts; it does not re-derive them from `lastHeartbeatAt`,
 * which would require a threshold invented in this file — and that threshold
 * would be wrong the moment an administrator changed the setting, leaving the
 * pill and the database disagreeing about which machines are dead. See
 * `workersTable.tsx` for the same rule stated at the column level.
 *
 * =============================================================================
 * TWO SCOPES OF ACTION, IN TWO PLACES
 * =============================================================================
 *
 *   1. **Per node** — delete this node. A `DataTableRowAction`, so it appears
 *      in the desktop grid's action cell, the tablet row expander and the phone
 *      card header from one declaration, with a confirmation that says plainly
 *      what happens to the work it was holding.
 *   2. **Per credential** — create, revoke. In the section below, for the
 *      reasons above.
 *
 * There is deliberately NO selection and no bulk bar: nothing on this page acts
 * on a set of nodes, and a checkbox column that gates no action is a column of
 * dead controls plus a tab stop per row for a keyboard user.
 *
 * =============================================================================
 * POLLING, AND WHY IT STOPS WITH THE TAB
 * =============================================================================
 *
 * A node's health changes with nobody touching it — that is the entire content
 * of a heartbeat — so this is one of the two admin surfaces where a poll is the
 * honest design. The shared `useVisiblePolling` (one implementation, in
 * `hooks/useVisiblePolling.ts`, extracted by this issue from `useJobs.ts`
 * rather than copied) tears the interval down while the tab is hidden and
 * fetches immediately on return. A fleet page left open on a second monitor
 * should not poll all day; a fleet page that resumes by waiting out a full
 * interval is worse than one that never paused, because hour-old health pills
 * that look live are the one wrong answer this page must not give.
 *
 * The poll REFRESHES rather than reloads: neither hook raises its loading flag
 * for a refresh, so rows stay on screen and the tables keep their scroll
 * offset, their expansion and their focus.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Container,
  Paper,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { Navigate } from 'react-router-dom';
import { DataTable } from '../../components/datatable';
import type { DataTableRowAction } from '../../components/datatable';
import { NodeCredentials } from '../../components/admin/NodeCredentials';
import { usePermissions } from '../../hooks/usePermissions';
import {
  WORKER_NODES_POLL_INTERVAL_MS,
  useNodeActions,
  useNodeCredentials,
  useVisiblePolling,
  useWorkerNodes,
} from '../../hooks/useWorkerNodes';
import type { WorkerNode } from '../../services/nodes';
import { NODES_TABLE_ID, buildWorkerNodeColumns } from './workersTable';

/** Mirrors the `Worker Nodes` card in `config/adminSections.tsx`, word for word. */
const PAGE_TITLE = 'Worker Nodes';
const PAGE_DESCRIPTION =
  'See which machines are attached to this deployment, what they are running, and whether they are healthy.';

interface StatTileProps {
  label: string;
  value: number | string;
  /** Secondary line — the number's caveat, when it has one. */
  hint?: string;
  emphasis?: 'default' | 'warning' | 'error';
}

/**
 * One number and what it means.
 *
 * The label is rendered ABOVE the value and both are plain text, so the pair
 * reads as one string to a screen reader in DOM order ("Stale 2") without a
 * visually-hidden duplicate. Lifted in shape from `JobsPage`'s tile, and kept
 * local to each page rather than shared: they are eight lines of layout, and a
 * shared "stat tile" is the component that grows a `variant` prop per caller.
 */
function StatTile({ label, value, hint, emphasis = 'default' }: StatTileProps) {
  const color =
    emphasis === 'error' ? 'error.main' : emphasis === 'warning' ? 'warning.main' : 'text.primary';

  return (
    <Paper variant="outlined" sx={{ px: 2, py: 1.5, minWidth: 120, flexGrow: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="h5" sx={{ fontWeight: 600, color }}>
        {value}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      )}
    </Paper>
  );
}

export default function WorkersPage() {
  const { hasPermission } = usePermissions();

  const { nodes, isLoading, error, refresh } = useWorkerNodes();
  const {
    credentials,
    isLoading: credentialsLoading,
    error: credentialsError,
    refresh: refreshCredentials,
  } = useNodeCredentials();

  const [notice, setNotice] = useState<string | null>(null);

  /**
   * The instant every relative timestamp on this page is measured against.
   *
   * ONE CLOCK FOR THE WHOLE RENDER, advanced on each refresh rather than read
   * per cell. Two reasons: fifteen rows each calling `new Date()` can render
   * two nodes that last spoke in the same second as "1 minute ago" and
   * "2 minutes ago"; and the credentials table's status chip and its revoke
   * action both judge expiry, so they must judge it against the same moment or
   * a credential expiring mid-render gets an `Active` chip beside a disabled
   * button.
   */
  const [renderedAt, setRenderedAt] = useState(() => new Date());

  /**
   * Re-read BOTH the fleet and the credentials, and re-date the page.
   *
   * One function, so the two tables are never a poll apart: an operator looking
   * at a stale node above a credential list that has not been re-read has no
   * way to know which of the two is behind. It also picks up a SECOND
   * administrator's revoke, which is a change this tab did not make.
   */
  const refreshAll = useCallback(() => {
    setRenderedAt(new Date());
    void refresh();
    void refreshCredentials();
  }, [refresh, refreshCredentials]);

  const actions = useNodeActions(refreshAll);
  useVisiblePolling(refreshAll, WORKER_NODES_POLL_INTERVAL_MS);

  const columns = useMemo(() => buildWorkerNodeColumns(renderedAt), [renderedAt]);

  const canWrite = hasPermission('nodes:write');

  const rowActions = useMemo(() => {
    // The ARRAY is gated, never a rendered control: a reader without
    // `nodes:write` gets an array that does not CONTAIN this, so it is absent
    // from the grid, the tablet expander and the phone card at once.
    if (!canWrite) return [] as DataTableRowAction<WorkerNode>[];

    return [
      {
        id: 'delete',
        label: 'Delete node',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        disabled: () => actions.isWorking,
        confirm: {
          title: 'Delete this worker node?',
          /**
           * THE JOBS SENTENCE IS THE WHOLE POINT OF THIS DIALOG.
           *
           * The API deletes the node record and clears `claimedByNodeId`; it
           * deletes no job. Work this node was holding is released and picked
           * up by the lease reaper — requeued, or failed on its normal attempt
           * budget — rather than lost. Without that sentence an operator
           * staring at a dead machine with eleven running jobs has to guess,
           * and the safe-looking guess ("don't touch it") leaves exactly the
           * jobs they were trying to unstick pinned to a node that is never
           * coming back.
           *
           * The credential sentence is here for the opposite reason: the API
           * does NOT revoke it, so the same token can register a new node, and
           * an operator who believes otherwise has not actually cut off the
           * machine they think they have.
           */
          description: (node) =>
            `"${node.name}" (${node.hostname}) will be forgotten. Its in-flight jobs are ` +
            'NOT deleted — they are released and requeued, so another worker picks them up. ' +
            'Its credential is not revoked either: the same token can register a new node, ' +
            'so revoke it below if the machine is gone for good.',
          confirmLabel: 'Delete node',
        },
        onClick: (node) => {
          void actions.removeNode(node.id).then((ok) => {
            if (ok) setNotice(`${node.name} deleted. Its in-flight jobs were released and requeued.`);
          });
        },
      },
    ] satisfies DataTableRowAction<WorkerNode>[];
  }, [canWrite, actions]);

  const emptyState = useMemo(
    () => (
      <Typography color="text.secondary">
        No worker nodes have registered yet. Create a node credential below and give it to a
        machine to attach one.
      </Typography>
    ),
    [],
  );

  /**
   * The health tally.
   *
   * COUNTS the API's verdicts; never re-derives them. `disabled` is counted off
   * `status`, not `health`, because it is not a liveness state at all — a
   * disabled node that is still heartbeating is both disabled and healthy, and
   * both facts belong in this strip.
   */
  const summary = useMemo(() => {
    const tally = {
      total: nodes.length,
      healthy: 0,
      stale: 0,
      offline: 0,
      disabled: 0,
      claimed: 0,
      running: 0,
    };
    for (const node of nodes) {
      if (node.health === 'healthy') tally.healthy += 1;
      else if (node.health === 'stale') tally.stale += 1;
      else tally.offline += 1;
      if (node.status === 'disabled') tally.disabled += 1;
      tally.claimed += node.jobCounts.pending;
      tally.running += node.jobCounts.running;
    }
    return tally;
  }, [nodes]);

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string, exactly as every sibling admin page does. It sits
  // after every hook so the hook order never changes.
  if (!hasPermission('nodes:read')) {
    return <Navigate to="/" replace />;
  }

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 4 }}>
        {/* Title and description MIRROR the registry card so the hub card, the
            rail row, the compact AppBar title and this `h1` all name the page
            identically. */}
        <Typography variant="h4" component="h1" gutterBottom>
          {PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {PAGE_DESCRIPTION}
          {/* Stated up front rather than left for the operator to discover by
              finding every control missing. */}
          {!canWrite && ' (read-only)'}
        </Typography>

        {actions.error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={actions.clearError}>
            {actions.error}
          </Alert>
        )}

        {/* ------------------------------------------------------------------
            THE SUMMARY STRIP — a tally of the API's own health verdicts.
            ------------------------------------------------------------- */}
        <Stack
          direction="row"
          spacing={2}
          useFlexGap
          sx={{ flexWrap: 'wrap', mb: 3 }}
          aria-label="Fleet summary"
        >
          <StatTile label="Nodes" value={summary.total} />
          <StatTile label="Healthy" value={summary.healthy} />
          <StatTile
            label="Stale"
            value={summary.stale}
            emphasis={summary.stale > 0 ? 'warning' : 'default'}
            hint="No recent heartbeat"
          />
          <StatTile label="Offline" value={summary.offline} />
          <StatTile
            label="Disabled"
            value={summary.disabled}
            emphasis={summary.disabled > 0 ? 'error' : 'default'}
            hint="Refusing claims"
          />
          <StatTile label="Claimed" value={summary.claimed} hint="Assigned, not started" />
          <StatTile label="Running" value={summary.running} />
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Paper sx={{ width: '100%', p: 2 }}>
          <Box sx={{ minWidth: 0 }}>
            <DataTable<WorkerNode>
              tableId={NODES_TABLE_ID}
              data-testid="admin-worker-nodes-table"
              ariaLabel="Worker nodes"
              columns={columns}
              rows={nodes}
              rowId={(node) => node.id}
              loading={isLoading}
              emptyState={emptyState}
              rowActions={rowActions}
              // No `pagination`, no `sort`, no `filters`: the endpoint takes no
              // query parameters at all and returns the whole fleet ordered by
              // name. See `workersTable.tsx` on why a control the server cannot
              // honour is worse than no control.
              csvExport={{ filename: 'worker-nodes' }}
            />
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Ordered by name. Health is derived by the API from each node&apos;s last heartbeat.
            The fleet is re-read every {WORKER_NODES_POLL_INTERVAL_MS / 1000} seconds while this
            tab is in front.
          </Typography>
        </Paper>

        {credentialsError && (
          <Alert severity="error" sx={{ mt: 3 }}>
            {credentialsError}
          </Alert>
        )}

        <NodeCredentials
          credentials={credentials}
          isLoading={credentialsLoading}
          canWrite={canWrite}
          isWorking={actions.isWorking}
          onCreate={actions.createCredential}
          onRevoke={actions.revokeCredential}
          now={renderedAt}
        />

        <Snackbar
          open={notice !== null}
          autoHideDuration={6000}
          onClose={() => setNotice(null)}
          message={notice}
        />
      </Box>
    </Container>
  );
}
