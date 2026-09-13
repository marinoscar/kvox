/**
 * Admin → Operations → Worker Nodes: the DataTable column contracts
 * (issue #271, epic #254).
 *
 * A sibling module rather than columns inlined in `WorkersPage.tsx`, for the
 * reason every table in this repo follows (`jobsTable.tsx` and
 * `components/admin/userListColumns.tsx` are the models): the column list is
 * the table's PUBLIC shape — what a test, a CSV export and both renderers read
 * — while the page is the state that feeds it. Keeping them apart lets a test
 * assert the contract without mounting a page and mocking its fetch layer.
 *
 * TWO COLUMN BUILDERS IN ONE MODULE, because the page has two tables and they
 * are not independent: the fleet answers "which machine is misbehaving" and the
 * credential list answers "which token do I cut off", and an operator moves
 * between them in one incident. Splitting them across two files would separate
 * the shared formatting (the owner cell, the relative timestamp, the masked
 * identifiers) from one of its two users, which is how two formatters that
 * disagree get written.
 *
 * =============================================================================
 * NO COLUMN IS `sortable`, `filterable` OR `searchable`, AND THAT IS THE API
 * =============================================================================
 *
 * `GET /api/admin/nodes` and `GET /api/admin/nodes/credentials` declare NO
 * `@Query()` at all (`nodes-admin.controller.ts`). Both return the whole
 * collection in one response — the fleet ordered by name, the credentials
 * newest first — so there is no page to ask for, no sort key to send and no
 * filter parameter to map onto.
 *
 * Sorting and filtering in this DataTable are ALWAYS server-side (`types.ts`
 * says so twice, for `sortable` and for `filterable`), so declaring either here
 * would put a control on screen that the page could only honour by filtering
 * `rows` itself — which the contract forbids — or by doing nothing at all. Both
 * flags default to `false` precisely so a table like this one cannot advertise
 * a control it has no way to answer. This is the same conclusion `patColumns.tsx`
 * reaches from the same evidence.
 *
 * A fleet is tens of machines, not thousands; if it ever needs a filter, the
 * endpoint grows a query parameter first and this file follows.
 *
 * =============================================================================
 * `health` IS RENDERED, NEVER RECOMPUTED
 * =============================================================================
 *
 * The health column reads `node.health` — the API's own derived verdict — and
 * chooses a colour for the word it was handed. It deliberately does NOT look at
 * `lastHeartbeatAt` and decide for itself, because the threshold is
 * `nodes.staleHeartbeatSeconds`, a SYSTEM SETTING this app never reads. A
 * client-side recompute would need a constant invented here, and that constant
 * would be wrong the moment an administrator changed the setting: the pill and
 * the database would disagree, and the pill is the one the operator believes.
 * It would also disagree with the fleet sweep that actually moves nodes to
 * `offline`, which is the same class of bug one layer up.
 *
 * `status` AND `health` ARE TWO COLUMNS, not one merged "state". They answer
 * different questions and are routinely, correctly in conflict: a `disabled`
 * node that is still heartbeating is both disabled and `healthy`, and a node
 * whose process was killed reads `online`/`stale` until the sweep catches it.
 * Merging them would force this file to pick a winner — and whichever it picked
 * would hide the other from the person trying to work out what happened.
 *
 * The three treatments an operator must be able to tell apart at a glance,
 * and how they differ by more than hue (colour alone is not an accessible
 * distinction, so each carries its own icon and its own word):
 *
 *   STALE    — filled warning chip, warning triangle. "Nobody has heard from
 *              this machine lately; it has not been declared dead."
 *   OFFLINE  — outlined neutral chip, cloud-off. "This machine is gone, and
 *              the deployment knows."
 *   DISABLED — filled error chip, block icon, in the STATUS column. "A human
 *              turned this off." It is not a liveness state at all, which is
 *              exactly why it cannot live in the health column.
 */

import BlockIcon from '@mui/icons-material/Block';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import RadioButtonCheckedIcon from '@mui/icons-material/RadioButtonChecked';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { Chip, Stack, Tooltip, Typography } from '@mui/material';
import type { ChipProps } from '@mui/material';
import type { DataTableColumn } from '../../components/datatable';
import { nodeCredentialStatus } from '../../services/nodes';
import type {
  NodeCredential,
  NodeCredentialStatus,
  NodeHealth,
  NodeOwner,
  NodeStatus,
  WorkerNode,
} from '../../services/nodes';
import { formatRelativeTime } from '../../utils/relativeTime';
// Imported from the sibling table module rather than re-implemented. Both are
// three-line functions, which is exactly why copying them is tempting and
// wrong: `jobsTable.tsx`'s own header explains that two formatters drift into
// one page reading "1500ms" beside another reading "1.5s" for the same number,
// and a fleet page whose timestamps are formatted differently from the queue
// page an operator just came from has the same problem in a worse place.
import { formatDateTime, shortId } from './jobsTable';

/**
 * Persistence keys for `user_settings.dataTables`. Constants, never derived
 * from the route or the heading: they are storage keys and must survive a
 * rename.
 */
export const NODES_TABLE_ID = 'admin-worker-nodes';
export const NODE_CREDENTIALS_TABLE_ID = 'admin-node-credentials';

// =============================================================================
// Chip vocabulary
// =============================================================================

/** How one state is drawn: a word, a colour, a fill, and an icon. */
interface ChipSpec {
  label: string;
  color: ChipProps['color'];
  variant: ChipProps['variant'];
  Icon: typeof BlockIcon;
}

/**
 * The DERIVED liveness verdict. Keys are `AdminNodeDto.health`'s enum, exactly.
 *
 * `stale` is filled-warning and `offline` is outlined-neutral on purpose: a
 * stale node is an OPEN QUESTION an operator may still be able to act on, while
 * an offline one is a settled fact. Drawing them in the same weight would make
 * a fleet of long-dead nodes shout as loudly as the one machine that stopped
 * answering five minutes ago.
 */
export const NODE_HEALTH_CHIPS: Record<NodeHealth, ChipSpec> = {
  healthy: {
    label: 'Healthy',
    color: 'success',
    variant: 'filled',
    Icon: CheckCircleIcon,
  },
  stale: {
    label: 'Stale',
    color: 'warning',
    variant: 'filled',
    Icon: WarningAmberIcon,
  },
  offline: {
    label: 'Offline',
    color: 'default',
    variant: 'outlined',
    Icon: CloudOffIcon,
  },
};

/**
 * The OPERATOR state. Keys are `AdminNodeDto.status`'s enum, exactly.
 *
 * `disabled` is the only one drawn in the error palette, and the only filled
 * one: it is the single value in either column that means a human deliberately
 * took this machine out of the rotation, and an operator scanning for "why is
 * nothing running here" needs it to be the thing their eye lands on.
 */
export const NODE_STATUS_CHIPS: Record<NodeStatus, ChipSpec> = {
  online: {
    label: 'Online',
    color: 'default',
    variant: 'outlined',
    Icon: RadioButtonCheckedIcon,
  },
  draining: {
    label: 'Draining',
    color: 'info',
    variant: 'outlined',
    Icon: PauseCircleIcon,
  },
  offline: {
    label: 'Offline',
    color: 'default',
    variant: 'outlined',
    Icon: CloudOffIcon,
  },
  disabled: {
    label: 'Disabled',
    color: 'error',
    variant: 'filled',
    Icon: BlockIcon,
  },
};

/** A credential's live-ness, from `nodeCredentialStatus` in the service module. */
const CREDENTIAL_STATUS_CHIPS: Record<NodeCredentialStatus, ChipSpec> = {
  active: {
    label: 'Active',
    color: 'success',
    variant: 'filled',
    Icon: CheckCircleIcon,
  },
  expired: {
    label: 'Expired',
    color: 'default',
    variant: 'outlined',
    Icon: CloudOffIcon,
  },
  revoked: {
    label: 'Revoked',
    color: 'error',
    variant: 'filled',
    Icon: BlockIcon,
  },
};

/**
 * Draw one state chip.
 *
 * `testId` is passed through so a test can name the exact chip on a given row
 * rather than searching the page for the word "Offline", which appears in both
 * the health and the status vocabularies by design.
 */
function stateChip(spec: ChipSpec, testId: string) {
  const { Icon } = spec;
  return (
    <Chip
      size="small"
      label={spec.label}
      color={spec.color}
      variant={spec.variant}
      // The icon carries the same information as the colour, for the same
      // reason every status chip in this app does: colour alone fails anyone
      // who cannot distinguish these hues, and a printed or screenshotted fleet
      // page is a common enough artefact that "it's fine, it's green" is not a
      // safe assumption.
      icon={<Icon fontSize="small" />}
      data-testid={testId}
    />
  );
}

// =============================================================================
// Formatting
// =============================================================================

/**
 * A heartbeat, in the unit the question is actually asked in.
 *
 * "Is this worker alive" is answered by "40 seconds ago" and not by "14:03",
 * which only helps if the reader also knows what time it is now — the same
 * argument `utils/relativeTime.ts` makes for the notification centre, and the
 * reason this reuses that helper instead of growing a second one.
 *
 * `null` is NEVER, not "unknown": a node that has never heartbeated is a real,
 * common state (it registered and then failed to start work), and the API reads
 * it as `stale`. Rendering it as an em dash would make the most suspicious node
 * in the fleet look like a formatting gap.
 */
export function formatHeartbeat(iso: string | null, now: Date): string {
  return iso ? formatRelativeTime(iso, now) : 'Never';
}

/**
 * The owner as one line: their display name when the account has one, their
 * email otherwise.
 *
 * Never both concatenated. The column is narrow, and an operator uses this to
 * answer "whose box is this" — for which either identifier alone is enough,
 * while the pair truncates to neither.
 */
export function formatOwner(owner: NodeOwner): string {
  return owner.name ?? owner.email;
}

/**
 * The job types a node declared it can run.
 *
 * An EMPTY LIST IS A REAL STATE and says "this node claims nothing" — a
 * configuration mistake that leaves a perfectly healthy machine idle forever,
 * and one of the few things this page can reveal that no other surface does. It
 * is spelled out rather than left blank, because a blank cell reads as missing
 * data.
 */
export function formatEligibleTypes(types: string[]): string {
  return types.length > 0 ? types.join(', ') : 'None declared';
}

/** An expiry, where `null` genuinely means "never" rather than "unknown". */
export function formatExpiry(iso: string | null): string {
  return iso ? formatDateTime(iso) : 'Never';
}

// =============================================================================
// The fleet columns
// =============================================================================

/**
 * @param now the instant every relative timestamp is measured against. Passed
 * in rather than read per cell so one render dates the whole fleet against ONE
 * moment — otherwise fifteen rows are each formatted against a slightly
 * different `new Date()`, and two nodes that last spoke in the same second can
 * render as "1 minute ago" and "2 minutes ago".
 */
export function buildWorkerNodeColumns(now: Date): DataTableColumn<WorkerNode>[] {
  return [
    {
      /**
       * The row-unique `primary` column, and therefore the row's ACCESSIBLE
       * NAME: `rowAccessibleName()` takes the first visible `primary` column's
       * scalar and names every row-action button and every card after it.
       *
       * The scalar carries the hostname alongside the name FOR THAT REASON.
       * `WorkerNode.name` is unique PER OWNER, not per deployment — two
       * operators may each run a `worker-1`, and this page shows everybody's —
       * so a scalar of `"worker-1"` alone would give two rows two delete
       * buttons both announced "Delete worker-1", on a page whose delete
       * button releases in-flight jobs. `hideable: false` for the same reason:
       * hiding this column would rename every control on the page after
       * whichever column happened to be `primary` next.
       */
      id: 'name',
      label: 'Node',
      priority: 'primary',
      hideable: false,
      minWidth: 220,
      flex: 1.2,
      value: (node) => `${node.name} (${node.hostname})`,
      render: (node) => (
        <Stack sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {node.name}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {node.hostname}
          </Typography>
        </Stack>
      ),
    },
    {
      // The API's derived verdict, rendered — see the module header.
      id: 'health',
      label: 'Health',
      priority: 'primary',
      width: 140,
      value: (node) => NODE_HEALTH_CHIPS[node.health].label,
      render: (node) =>
        stateChip(NODE_HEALTH_CHIPS[node.health], `node-health-${node.id}`),
    },
    {
      // Operator state. A separate column from health, deliberately.
      id: 'status',
      label: 'Status',
      priority: 'primary',
      width: 140,
      value: (node) => NODE_STATUS_CHIPS[node.status].label,
      render: (node) =>
        stateChip(NODE_STATUS_CHIPS[node.status], `node-status-${node.id}`),
    },
    {
      /**
       * The relative time is the CELL and the absolute time is the tooltip,
       * not the other way round: "40 seconds ago" answers the question, and the
       * exact timestamp is what somebody correlating against a log needs a
       * moment later.
       *
       * The `value` scalar is the ABSOLUTE time, because it is what the CSV
       * export writes. "3 minutes ago" in a file that lands in a downloads
       * folder and gets mailed around is meaningless the moment it is saved —
       * relative to what?
       */
      id: 'lastHeartbeatAt',
      label: 'Last heartbeat',
      priority: 'primary',
      minWidth: 160,
      value: (node) => (node.lastHeartbeatAt ? formatDateTime(node.lastHeartbeatAt) : 'Never'),
      render: (node) => (
        <Tooltip title={node.lastHeartbeatAt ? formatDateTime(node.lastHeartbeatAt) : ''}>
          <Typography variant="body2" noWrap>
            {formatHeartbeat(node.lastHeartbeatAt, now)}
          </Typography>
        </Tooltip>
      ),
    },
    {
      /**
       * The node's declared ceiling, not how many it is running — that is the
       * `running` column beside it. Rendered as the bare number rather than
       * "2 of 4": the two come from different places (one self-reported at
       * registration, one counted from the jobs table) and printing them as a
       * fraction would imply a relationship the API does not guarantee, e.g.
       * for a node that lowered its concurrency while holding more jobs than
       * the new limit.
       */
      id: 'concurrency',
      label: 'Concurrency',
      priority: 'secondary',
      align: 'right',
      width: 120,
      value: (node) => node.concurrency,
    },
    {
      // CLAIMED, in the API's vocabulary `pending`: assigned to this node and
      // not yet started. Named for what an operator sees rather than for the
      // column in the database.
      id: 'claimed',
      label: 'Claimed',
      priority: 'secondary',
      align: 'right',
      width: 110,
      value: (node) => node.jobCounts.pending,
    },
    {
      id: 'running',
      label: 'Running',
      priority: 'secondary',
      align: 'right',
      width: 110,
      value: (node) => node.jobCounts.running,
    },
    {
      id: 'succeeded',
      label: 'Succeeded',
      priority: 'secondary',
      align: 'right',
      width: 120,
      value: (node) => node.jobCounts.succeeded,
    },
    {
      id: 'failed',
      label: 'Failed',
      priority: 'secondary',
      align: 'right',
      width: 110,
      value: (node) => node.jobCounts.failed,
    },
    {
      id: 'platform',
      label: 'Platform',
      priority: 'detail',
      minWidth: 140,
      value: (node) => node.platform,
    },
    {
      id: 'cliVersion',
      label: 'CLI version',
      priority: 'detail',
      minWidth: 120,
      value: (node) => node.cliVersion,
    },
    {
      /**
       * `truncate`, because a node that declares a dozen types would otherwise
       * make one row taller than the rest of the table. The full list is in the
       * tooltip, in the card's expandable region, and in the CSV.
       */
      id: 'eligibleTypes',
      label: 'Eligible types',
      priority: 'detail',
      truncate: true,
      minWidth: 220,
      value: (node) => formatEligibleTypes(node.eligibleTypes),
    },
    {
      id: 'owner',
      label: 'Owner',
      priority: 'detail',
      minWidth: 200,
      value: (node) => formatOwner(node.owner),
    },
    {
      id: 'registeredAt',
      label: 'Registered',
      priority: 'detail',
      minWidth: 180,
      value: (node) => formatDateTime(node.registeredAt),
    },
    {
      id: 'id',
      label: 'ID',
      priority: 'detail',
      truncate: true,
      minWidth: 200,
      value: (node) => node.id,
    },
  ];
}

// =============================================================================
// The credential columns
// =============================================================================

/**
 * @param now the instant expiry is judged against, for the same
 * one-render-one-moment reason the fleet columns take it: a credential that
 * expires during a render must not be `Active` in one row's chip and `Expired`
 * in the row action that reads the same predicate.
 */
export function buildNodeCredentialColumns(now: Date): DataTableColumn<NodeCredential>[] {
  return [
    {
      /**
       * The row's accessible name, with a short slice of the id appended
       * UNCONDITIONALLY — `createNodeCredentialSchema` does not require `name`
       * to be unique and the service does not check, so a fleet built by a
       * script may hold twenty credentials all called `worker`. Without the
       * suffix that is twenty buttons announced "Revoke for worker", on the one
       * control on this page that is an irreversible security action.
       *
       * This is `patColumns.tsx`'s decision, reached from the same evidence;
       * see its header for why the fix is a suffix here rather than
       * uniqueness enforcement at create time (it cannot fix rows that already
       * exist, and the endpoint is reachable from a script anyway).
       *
       * `render` keeps the plain name, so the visible cell is unchanged.
       */
      id: 'name',
      label: 'Name',
      priority: 'primary',
      hideable: false,
      minWidth: 180,
      flex: 1,
      value: (credential) => `${credential.name} (${shortId(credential.id)})`,
      render: (credential) => <Typography variant="body2">{credential.name}</Typography>,
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      width: 140,
      value: (credential) => CREDENTIAL_STATUS_CHIPS[nodeCredentialStatus(credential, now)].label,
      render: (credential) =>
        stateChip(
          CREDENTIAL_STATUS_CHIPS[nodeCredentialStatus(credential, now)],
          `credential-status-${credential.id}`,
        ),
    },
    {
      /**
       * The masked prefix, and `exportable: false`.
       *
       * Not about secrecy on screen — the prefix is non-secret by construction
       * and the API publishes it — but about the LIFETIME of the artefact. A
       * CSV is a file: it lands in a downloads folder, gets mailed around, and
       * outlives the session, the credential and often the employment that
       * produced it. Token material of any length has no business in a document
       * with that lifetime, and "it's only the first few characters" is exactly
       * the reasoning that puts the whole secret in the next file. This is
       * `patColumns.tsx`'s rule, applied to the credential family that can
       * attach a machine to the deployment.
       */
      id: 'tokenPrefix',
      label: 'Token',
      priority: 'primary',
      exportable: false,
      minWidth: 160,
      value: (credential) => `${credential.tokenPrefix}…`,
      render: (credential) => (
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {credential.tokenPrefix}…
        </Typography>
      ),
    },
    {
      /**
       * The whole reason the ADMIN credential list exists as a separate route
       * from the caller's own: an administrator auditing long-lived worker
       * tokens needs to know whose they are.
       */
      id: 'owner',
      label: 'Owner',
      priority: 'secondary',
      minWidth: 200,
      value: (credential) => formatOwner(credential.owner),
      render: (credential) => (
        <Tooltip title={credential.owner.email}>
          <Typography variant="body2" noWrap>
            {formatOwner(credential.owner)}
          </Typography>
        </Tooltip>
      ),
    },
    {
      id: 'createdAt',
      label: 'Created',
      priority: 'secondary',
      minWidth: 180,
      value: (credential) => formatDateTime(credential.createdAt),
    },
    {
      /**
       * "Is this node still alive, or is this credential safe to revoke" — the
       * API's own words for what this field is for. `Never` rather than an em
       * dash: a credential minted months ago and never used is the single most
       * revocable thing on this page, and a blank cell hides it.
       */
      id: 'lastUsedAt',
      label: 'Last used',
      priority: 'secondary',
      minWidth: 180,
      value: (credential) =>
        credential.lastUsedAt ? formatRelativeTime(credential.lastUsedAt, now) : 'Never',
    },
    {
      /**
       * `Never` here means NEVER EXPIRES, and it is the intended default rather
       * than an omission: a worker runs unattended for months, and revocation
       * — the row action beside this cell — is the control, not a clock. See
       * `services/nodes.ts` and the API's `create-node-credential.dto.ts`.
       */
      id: 'expiresAt',
      label: 'Expires',
      priority: 'secondary',
      minWidth: 180,
      value: (credential) => formatExpiry(credential.expiresAt),
    },
    {
      // Kept as a column rather than dropped once revoked rows are visibly
      // chipped: the audit question is "when was this cut off", and the chip
      // only answers "was it".
      id: 'revokedAt',
      label: 'Revoked',
      priority: 'detail',
      minWidth: 180,
      value: (credential) => (credential.revokedAt ? formatDateTime(credential.revokedAt) : ''),
    },
    {
      id: 'id',
      label: 'ID',
      priority: 'detail',
      truncate: true,
      minWidth: 200,
      value: (credential) => credential.id,
    },
  ];
}
