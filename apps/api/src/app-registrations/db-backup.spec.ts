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

import { restoreGateRegistry } from '@marinoscar/platform-api/db-backup';
import { buildRestoreGateContext, describeRestoreGateConformance } from '@marinoscar/platform-api/db-backup/testing';

import { KVOX_EXTENSIONS_GATE_ID, KVOX_REQUIRED_EXTENSIONS, checkKvoxExtensions } from './db-backup';

interface RecordedClient {
  config: Record<string, unknown>;
  queries: Array<{ text: string; values: unknown[] | undefined }>;
  ended: boolean;
}

const mockState: {
  clients: RecordedClient[];
  /** What `pg_available_extensions` offers in the current case. */
  offered: string[];
  connectError: Error | null;
} = { clients: [], offered: [], connectError: null };

jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation((config: Record<string, unknown>) => {
    const recorded: RecordedClient = { config, queries: [], ended: false };
    mockState.clients.push(recorded);
    return {
      connect: jest.fn(async () => {
        if (mockState.connectError) throw mockState.connectError;
      }),
      query: jest.fn(async (text: string, values?: unknown[]) => {
        recorded.queries.push({ text, values });
        const wanted = (values?.[0] ?? []) as string[];
        return { rows: mockState.offered.filter((name) => wanted.includes(name)).map((name) => ({ name })) };
      }),
      end: jest.fn(async () => {
        recorded.ended = true;
      }),
    };
  }),
}));

/** Statements that would change the cluster; none may ever be sent. */
const WRITE_STATEMENT = /\b(create|drop|alter|rename|insert|update|delete|truncate|grant|revoke)\b/i;

beforeEach(() => {
  mockState.clients = [];
  mockState.offered = ['vector', 'pg_trgm', 'plpgsql'];
  mockState.connectError = null;
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
    mockState.offered = ['pg_trgm', 'plpgsql'];

    const outcome = await checkKvoxExtensions(buildRestoreGateContext());

    expect(outcome.status).toBe('fail');
    expect(outcome.message).toContain('vector');
    expect(outcome.message).not.toContain('pg_trgm');
    expect(outcome.action).toMatch(/Install the PostgreSQL package that provides vector/);
    expect(outcome.action).toMatch(/creates nothing itself/);
  });

  it('fails naming pg_trgm when only the trigram extension is missing', async () => {
    mockState.offered = ['vector'];

    const outcome = await checkKvoxExtensions(buildRestoreGateContext());

    expect(outcome.status).toBe('fail');
    expect(outcome.message).toContain('pg_trgm');
    expect(outcome.message).not.toMatch(/\bvector\b/);
    expect(outcome.action).toMatch(/provides pg_trgm/);
  });

  it('names both extensions when the cluster offers neither', async () => {
    mockState.offered = ['plpgsql'];

    const outcome = await checkKvoxExtensions(buildRestoreGateContext());

    expect(outcome.status).toBe('fail');
    expect(outcome.message).toContain('vector and pg_trgm');
  });

  it('issues exactly one statement, a SELECT on pg_available_extensions, and never a write', async () => {
    await checkKvoxExtensions(buildRestoreGateContext());
    mockState.offered = [];
    await checkKvoxExtensions(buildRestoreGateContext());

    expect(mockState.clients).toHaveLength(2);
    for (const client of mockState.clients) {
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

    const [client] = mockState.clients;
    expect(client.config).toMatchObject({ host: 'cluster.internal', port: 6543, user: 'admin_user', database: 'postgres' });
    expect(client.ended).toBe(true);
  });

  it('closes the connection even when the query fails', async () => {
    const { Client } = jest.requireMock('pg') as { Client: jest.Mock };
    Client.mockImplementationOnce((config: Record<string, unknown>) => {
      const recorded: RecordedClient = { config, queries: [], ended: false };
      mockState.clients.push(recorded);
      return {
        connect: jest.fn(async () => undefined),
        query: jest.fn(async () => {
          throw new Error('permission denied for view pg_available_extensions');
        }),
        end: jest.fn(async () => {
          recorded.ended = true;
        }),
      };
    });

    await expect(checkKvoxExtensions(buildRestoreGateContext())).rejects.toThrow(/permission denied/);
    expect(mockState.clients[0].ended).toBe(true);
  });

  it('rejects when the cluster cannot be reached, so the pre-flight fails closed', async () => {
    mockState.connectError = new Error('connect ECONNREFUSED');

    await expect(checkKvoxExtensions(buildRestoreGateContext())).rejects.toThrow(/ECONNREFUSED/);
    expect(mockState.clients[0].queries).toEqual([]);
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
