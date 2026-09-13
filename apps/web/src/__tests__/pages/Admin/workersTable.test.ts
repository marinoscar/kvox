/**
 * Admin → Operations → Worker Nodes: the column contracts (issue #271, epic #254).
 *
 * The table's MECHANICS — pagination, the column picker, CSV escaping, the
 * renderer switch, the axe pass — are asserted once for every table in
 * `runDataTableConformanceSuite` and are not repeated here. What this file
 * covers is the part of the contract that is specific to a FLEET page and could
 * be wrong while the DataTable is perfectly fine:
 *
 *   * that no column advertises a control the endpoint cannot answer;
 *   * that the three states an operator must tell apart at a glance — stale,
 *     offline, disabled — are drawn differently, and differ by more than hue;
 *   * that the row-unique scalars really are unique, since they become the
 *     accessible name of a delete button and of a revoke button;
 *   * that `null` is rendered as the real answer it is ("Never", "None
 *     declared") rather than as a gap.
 */

import { describe, it, expect } from 'vitest';
import {
  NODE_CREDENTIALS_TABLE_ID,
  NODES_TABLE_ID,
  NODE_HEALTH_CHIPS,
  NODE_STATUS_CHIPS,
  buildNodeCredentialColumns,
  buildWorkerNodeColumns,
  formatEligibleTypes,
  formatExpiry,
  formatHeartbeat,
  formatOwner,
} from '../../../pages/Admin/workersTable';
import { NODE_HEALTHS, NODE_STATUSES, nodeCredentialStatus } from '../../../services/nodes';
import type { NodeCredential, WorkerNode } from '../../../services/nodes';

const NOW = new Date('2026-01-01T12:00:00.000Z');

function node(overrides: Partial<WorkerNode> = {}): WorkerNode {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'worker-a',
    hostname: 'build-box-01',
    platform: 'linux-x64',
    cliVersion: '1.4.0',
    eligibleTypes: ['image.thumbnail', 'email.send'],
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

function credential(overrides: Partial<NodeCredential> = {}): NodeCredential {
  return {
    id: '22222222-2222-4222-8222-222222222222',
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

const nodeColumns = buildWorkerNodeColumns(NOW);
const credentialColumns = buildNodeCredentialColumns(NOW);

function column<Row>(columns: { id: string }[], id: string) {
  const found = columns.find((candidate) => candidate.id === id);
  expect(found, `column ${id} must exist`).toBeDefined();
  return found as unknown as import('../../../components/datatable').DataTableColumn<Row>;
}

describe('the table ids', () => {
  it('are constants, so a persisted layout survives a rename of the page', () => {
    expect(NODES_TABLE_ID).toBe('admin-worker-nodes');
    expect(NODE_CREDENTIALS_TABLE_ID).toBe('admin-node-credentials');
    expect(NODES_TABLE_ID).not.toBe(NODE_CREDENTIALS_TABLE_ID);
  });
});

describe('what the endpoints honour: nothing', () => {
  it('declares no sortable, filterable or searchable column on either table', () => {
    // `GET /api/admin/nodes` and `GET /api/admin/nodes/credentials` take no
    // `@Query()` at all. Sorting and filtering in this DataTable are always
    // server-side, so any of these flags would put a control on screen that
    // could only do nothing — or be honoured by filtering `rows` client-side,
    // which the contract forbids.
    for (const col of [...nodeColumns, ...credentialColumns]) {
      expect(col.sortable, `${col.id} must not be sortable`).toBeFalsy();
      expect(col.filterable, `${col.id} must not be filterable`).toBeFalsy();
      expect(col.searchable, `${col.id} must not be searchable`).toBeFalsy();
    }
  });
});

describe('health and status are two columns, and both are rendered from the API', () => {
  it('covers every value the API can send, with no extras invented', () => {
    // Keyed off the enums the service module mirrors from the DTOs. A health
    // value the API adds and this map does not have would be an undefined
    // lookup and a blank cell on the one column an incident is read from.
    expect(Object.keys(NODE_HEALTH_CHIPS).sort()).toEqual([...NODE_HEALTHS].sort());
    expect(Object.keys(NODE_STATUS_CHIPS).sort()).toEqual([...NODE_STATUSES].sort());
  });

  it('renders the API’s derived verdict, never one recomputed from the heartbeat', () => {
    // The threshold is `nodes.staleHeartbeatSeconds`, a system setting this app
    // never reads. So a node that heartbeated one minute ago and is marked
    // `stale` renders STALE, and a node that has not been heard from since 1999
    // and is marked `healthy` renders HEALTHY — the API's answer wins in both
    // directions, or the pill and the database can disagree.
    const health = column<WorkerNode>(nodeColumns, 'health');

    expect(health.value?.(node({ lastHeartbeatAt: '2026-01-01T11:59:00.000Z', health: 'stale' })))
      .toBe('Stale');
    expect(health.value?.(node({ lastHeartbeatAt: '1999-01-01T00:00:00.000Z', health: 'healthy' })))
      .toBe('Healthy');
  });

  it('draws stale and offline differently, and by more than colour', () => {
    const stale = NODE_HEALTH_CHIPS.stale;
    const offline = NODE_HEALTH_CHIPS.offline;

    expect(stale.label).not.toBe(offline.label);
    expect(stale.color).not.toBe(offline.color);
    // A stale node is an open question; an offline one is a settled fact. The
    // fill is what stops a fleet of long-dead nodes shouting as loudly as the
    // one machine that stopped answering five minutes ago.
    expect(stale.variant).not.toBe(offline.variant);
    // Colour alone is not an accessible distinction — and a fleet page is a
    // commonly screenshotted artefact.
    expect(stale.Icon).not.toBe(offline.Icon);
  });

  it('draws disabled distinctly from both, in the status column where it belongs', () => {
    const disabled = NODE_STATUS_CHIPS.disabled;

    for (const health of [NODE_HEALTH_CHIPS.stale, NODE_HEALTH_CHIPS.offline]) {
      expect(disabled.label).not.toBe(health.label);
      expect(disabled.color).not.toBe(health.color);
      expect(disabled.Icon).not.toBe(health.Icon);
    }
    // `disabled` is the only value in either vocabulary in the error palette:
    // it is the one that means a human deliberately took this machine out.
    expect(disabled.color).toBe('error');
    expect(NODE_STATUS_CHIPS.online.color).not.toBe('error');
  });

  it('keeps disabled-and-healthy readable as both, because that is a real state', () => {
    // A disabled node that is still heartbeating is both disabled and healthy.
    // Merging the two columns would force one of the two facts to be hidden
    // from the person trying to work out what happened.
    const disabledButAlive = node({ status: 'disabled', health: 'healthy' });

    expect(column<WorkerNode>(nodeColumns, 'status').value?.(disabledButAlive)).toBe('Disabled');
    expect(column<WorkerNode>(nodeColumns, 'health').value?.(disabledButAlive)).toBe('Healthy');
  });
});

describe('the fleet columns', () => {
  it('makes the row-unique scalar unique across owners, since it names the delete button', () => {
    // `WorkerNode.name` is unique PER OWNER, and this page shows everybody's.
    // Two `worker-1` rows would otherwise give two delete buttons both
    // announced "Delete node for worker-1", on a control that releases
    // in-flight jobs.
    const name = column<WorkerNode>(nodeColumns, 'name');
    const a = name.value?.(node({ name: 'worker-1', hostname: 'box-a' }));
    const b = name.value?.(node({ name: 'worker-1', hostname: 'box-b' }));

    expect(a).not.toBe(b);
    expect(a).toContain('worker-1');
    expect(a).toContain('box-a');
    expect(name.hideable).toBe(false);
    expect(name.priority).toBe('primary');
  });

  it('exports an ABSOLUTE heartbeat while rendering a relative one', () => {
    // "3 minutes ago" in a CSV that lands in a downloads folder is meaningless
    // the moment it is saved — relative to what?
    const heartbeat = column<WorkerNode>(nodeColumns, 'lastHeartbeatAt');
    const scalar = heartbeat.value?.(node({ lastHeartbeatAt: '2026-01-01T11:59:00.000Z' }));

    expect(scalar).not.toMatch(/ago|Just now/i);
    expect(scalar).toBe(new Date('2026-01-01T11:59:00.000Z').toLocaleString());
  });

  it('spells a missing heartbeat "Never", because it is the most suspicious row on the page', () => {
    expect(formatHeartbeat(null, NOW)).toBe('Never');
    expect(column<WorkerNode>(nodeColumns, 'lastHeartbeatAt').value?.(node({ lastHeartbeatAt: null })))
      .toBe('Never');
  });

  it('surfaces the per-node job counts the fleet endpoint carries', () => {
    const row = node({ jobCounts: { running: 7, pending: 5, succeeded: 11, failed: 2, total: 25 } });

    // "Claimed" is this page's word for the API's `pending`: assigned to this
    // node and not yet started.
    expect(column<WorkerNode>(nodeColumns, 'claimed').value?.(row)).toBe(5);
    expect(column<WorkerNode>(nodeColumns, 'running').value?.(row)).toBe(7);
    expect(column<WorkerNode>(nodeColumns, 'succeeded').value?.(row)).toBe(11);
    expect(column<WorkerNode>(nodeColumns, 'failed').value?.(row)).toBe(2);
  });

  it('says "None declared" for a node that claims no job type', () => {
    // A perfectly healthy machine that will sit idle forever — a configuration
    // mistake this page is one of the few places to reveal. A blank cell would
    // read as missing data.
    expect(formatEligibleTypes([])).toBe('None declared');
    expect(column<WorkerNode>(nodeColumns, 'eligibleTypes').value?.(node({ eligibleTypes: [] })))
      .toBe('None declared');
  });

  it('shows one owner identifier, preferring the display name', () => {
    expect(formatOwner({ id: 'u', email: 'ops@example.com', name: 'Ops' })).toBe('Ops');
    expect(formatOwner({ id: 'u', email: 'ops@example.com', name: null })).toBe('ops@example.com');
  });
});

describe('the credential columns', () => {
  it('never declares a `token` column, and keeps the prefix out of the CSV', () => {
    expect(credentialColumns.some((col) => col.id === 'token')).toBe(false);
    // Not about secrecy on screen — the prefix is non-secret and the API
    // publishes it — but about the LIFETIME of a file that gets mailed around.
    expect(column<NodeCredential>(credentialColumns, 'tokenPrefix').exportable).toBe(false);
  });

  it('disambiguates same-named credentials, since the scalar names the revoke button', () => {
    const name = column<NodeCredential>(credentialColumns, 'name');
    const a = name.value?.(credential({ id: 'aaaaaaaa-0000-4000-8000-000000000000', name: 'worker' }));
    const b = name.value?.(credential({ id: 'bbbbbbbb-0000-4000-8000-000000000000', name: 'worker' }));

    expect(a).not.toBe(b);
    expect(a).toContain('worker');
  });

  it('treats a null expiry as NEVER EXPIRES, not as an unknown or an expiry in 1970', () => {
    // The intended default for an unattended worker. `new Date(null)` is the
    // epoch, so a naive comparison would mark every long-lived credential dead.
    expect(formatExpiry(null)).toBe('Never');
    expect(nodeCredentialStatus({ expiresAt: null, revokedAt: null }, NOW)).toBe('active');
  });

  it('ranks revoked above expired, and both above active', () => {
    expect(
      nodeCredentialStatus(
        { expiresAt: '2025-01-01T00:00:00.000Z', revokedAt: '2025-06-01T00:00:00.000Z' },
        NOW,
      ),
    ).toBe('revoked');
    expect(nodeCredentialStatus({ expiresAt: '2025-01-01T00:00:00.000Z', revokedAt: null }, NOW))
      .toBe('expired');
    expect(nodeCredentialStatus({ expiresAt: '2027-01-01T00:00:00.000Z', revokedAt: null }, NOW))
      .toBe('active');
  });

  it('says "Never" for a credential that has never authenticated', () => {
    // The most revocable thing on the page; a blank cell would hide it.
    expect(column<NodeCredential>(credentialColumns, 'lastUsedAt').value?.(
      credential({ lastUsedAt: null }),
    )).toBe('Never');
  });

  it('carries the owner, which is the reason the admin list exists at all', () => {
    expect(column<NodeCredential>(credentialColumns, 'owner').value?.(credential())).toBe('Ops');
  });
});
