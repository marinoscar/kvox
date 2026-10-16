// =============================================================================
// The restore gate this app registers: `<APP_SLUG>-extensions` (issue #471)
// =============================================================================
//
// The gate answers one question on the target cluster: can it install the
// extensions this app's schema needs (`vector`, `pg_trgm`)? It is a restore
// PRE-FLIGHT gate, so the rule that matters is that it only ever READS: one
// `SELECT` on `pg_available_extensions`, and never a CREATE, DROP, ALTER or
// rename. The `pg` client is mocked here, so the test records exactly which
// statements the gate sends.
// =============================================================================

import { Client } from 'pg';

import { restoreGateRegistry } from '@marinoscar/platform-api/db-backup';
import { buildRestoreGateContext, describeRestoreGateConformance } from '@marinoscar/platform-api/db-backup/testing';

import { KVOX_EXTENSIONS_GATE_ID, KVOX_REQUIRED_EXTENSIONS, checkKvoxExtensions } from './db-backup';

interface RecordedClient {
  host: string | undefined;
  port: number | undefined;
  user: string | undefined;
  database: string | undefined;
  queries: Array<{ text: string; values: unknown[] | undefined }>;
  ended: boolean;
}

const state: {
  clients: RecordedClient[];
  /** What `pg_available_extensions` offers in the current case. */
  offered: string[];
  connectError: Error | null;
  queryError: Error | null;
} = { clients: [], offered: [], connectError: null, queryError: null };

// The `pg` module cannot be replaced with `jest.mock` here: the app registrations (this file's
// subject among them) are loaded by the shared test setup before a spec's mocks exist, so the
// gate holds the real `Client` class. Spying on its prototype works on that same class, and no
// socket is ever opened (`connect` is stubbed).
function recordedFor(client: unknown): RecordedClient {
  const found = state.clients.find((entry) => (entry as unknown as { _client: unknown })._client === client);
  if (found) return found;
  const real = client as Pick<RecordedClient, 'host' | 'port' | 'user' | 'database'>;
  const created: RecordedClient = {
    host: real.host,
    port: real.port,
    user: real.user,
    database: real.database,
    queries: [],
    ended: false,
  };
  Object.defineProperty(created, '_client', { value: client, enumerable: false });
  state.clients.push(created);
  return created;
}

function installClientSpies(): void {
  jest.spyOn(Client.prototype, 'connect').mockImplementation(async function (this: Client) {
    recordedFor(this);
    if (state.connectError) throw state.connectError;
  } as never);
  jest.spyOn(Client.prototype, 'query').mockImplementation((async function (this: Client, text: string, values?: unknown[]) {
    recordedFor(this).queries.push({ text, values });
    if (state.queryError) throw state.queryError;
    const wanted = (values?.[0] ?? []) as string[];
    return { rows: state.offered.filter((name) => wanted.includes(name)).map((name) => ({ name })) };
  }) as never);
  jest.spyOn(Client.prototype, 'end').mockImplementation((async function (this: Client) {
    recordedFor(this).ended = true;
  }) as never);
}

/** Statements that would change the cluster; none may ever be sent. */
const WRITE_STATEMENT = /\b(create|drop|alter|rename|insert|update|delete|truncate|grant|revoke)\b/i;

beforeEach(() => {
  state.clients = [];
  state.offered = ['vector', 'pg_trgm', 'plpgsql'];
  state.connectError = null;
  state.queryError = null;
  installClientSpies();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the app extensions restore gate', () => {
  it('requires the two extensions the schema uses', () => {
    expect([...KVOX_REQUIRED_EXTENSIONS]).toEqual(['vector', 'pg_trgm']);
  });

  it('uses an id the registry accepts, and is registered', () => {
    expect(KVOX_EXTENSIONS_GATE_ID).toMatch(/^[a-z][a-z0-9_-]{1,63}$/);
    expect(restoreGateRegistry.list().map((gate) => gate.id)).toContain(KVOX_EXTENSIONS_GATE_ID);
  });

  it('passes when the cluster offers both extensions', async () => {
    const outcome = await checkKvoxExtensions(buildRestoreGateContext());

    expect(outcome.status).toBe('pass');
    expect(outcome.message).toContain('vector');
    expect(outcome.message).toContain('pg_trgm');
  });

  it('fails naming vector, with the remedy, when pgvector is not installable', async () => {
    state.offered = ['pg_trgm', 'plpgsql'];

    const outcome = await checkKvoxExtensions(buildRestoreGateContext());

    expect(outcome.status).toBe('fail');
    expect(outcome.message).toContain('vector');
    expect(outcome.message).not.toContain('pg_trgm');
    expect(outcome.action).toMatch(/Install the PostgreSQL package that provides vector/);
    expect(outcome.action).toMatch(/creates nothing itself/);
  });

  it('fails naming pg_trgm when only the trigram extension is missing', async () => {
    state.offered = ['vector'];

    const outcome = await checkKvoxExtensions(buildRestoreGateContext());

    expect(outcome.status).toBe('fail');
    expect(outcome.message).toContain('pg_trgm');
    expect(outcome.message).not.toMatch(/\bvector\b/);
    expect(outcome.action).toMatch(/provides pg_trgm/);
  });

  it('names both extensions when the cluster offers neither', async () => {
    state.offered = ['plpgsql'];

    const outcome = await checkKvoxExtensions(buildRestoreGateContext());

    expect(outcome.status).toBe('fail');
    expect(outcome.message).toContain('vector and pg_trgm');
  });

  it('issues exactly one statement, a SELECT on pg_available_extensions, and never a write', async () => {
    await checkKvoxExtensions(buildRestoreGateContext());
    state.offered = [];
    await checkKvoxExtensions(buildRestoreGateContext());

    expect(state.clients).toHaveLength(2);
    for (const client of state.clients) {
      expect(client.queries).toHaveLength(1);
      const [{ text, values }] = client.queries;
      expect(text).toMatch(/^\s*SELECT\b/i);
      expect(text).toMatch(/\bFROM\s+pg_available_extensions\b/i);
      expect(text).not.toMatch(WRITE_STATEMENT);
      expect(values).toEqual([['vector', 'pg_trgm']]);
    }
  });

  it('connects with the pre-flight admin connection coordinates and closes the connection', async () => {
    const connection = { host: 'cluster.internal', port: '6543', user: 'admin_user', database: 'postgres', liveDatabase: 'app' };
    const base = buildRestoreGateContext();

    await checkKvoxExtensions(buildRestoreGateContext({ facts: { ...base.facts, connection } }));

    const [client] = state.clients;
    expect(client).toMatchObject({ host: 'cluster.internal', port: 6543, user: 'admin_user', database: 'postgres' });
    expect(client.ended).toBe(true);
  });

  it('closes the connection even when the query fails', async () => {
    state.queryError = new Error('permission denied for view pg_available_extensions');

    await expect(checkKvoxExtensions(buildRestoreGateContext())).rejects.toThrow(/permission denied/);
    expect(state.clients[0].ended).toBe(true);
  });

  it('rejects when the cluster cannot be reached, so the pre-flight fails closed', async () => {
    state.connectError = new Error('connect ECONNREFUSED');

    await expect(checkKvoxExtensions(buildRestoreGateContext())).rejects.toThrow(/ECONNREFUSED/);
    expect(state.clients[0].queries).toEqual([]);
  });
});

// The platform's conformance kit for any gate: valid definition, answers within the bound,
// writes nothing to its context, repeatable.
describeRestoreGateConformance(
  {
    id: KVOX_EXTENSIONS_GATE_ID,
    label: 'extensions',
    check: (ctx) => checkKvoxExtensions(ctx),
  },
  {
    describe,
    it,
    expect,
    scenarios: [{ name: 'both extensions offered', expectStatus: 'pass' }],
  },
);
