import { randomUUID } from 'node:crypto';

// A tiny in-memory table store for the library import specs: equality, `not`, `in` and null matches.

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, want]) => {
    const have = row[key];
    if (want !== null && typeof want === 'object' && !(want instanceof Date)) {
      if ('not' in want) return want.not === null ? have !== null && have !== undefined : have !== want.not;
      if ('in' in want) return (want.in as unknown[]).includes(have);
    }
    return (have ?? null) === (want ?? null);
  });
}

function table(defaults: () => Row = () => ({})) {
  const rows: Row[] = [];
  const delegate = {
    rows,
    findUnique: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    findFirst: async ({ where }: any = {}) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: any = {}) => rows.filter((r) => matches(r, where)),
    create: async ({ data }: any) => {
      const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...defaults(), ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error('row not found');
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
    groupBy: async ({ where }: any) => {
      const counts = new Map<string, number>();
      for (const row of rows.filter((r) => matches(r, where))) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      return [...counts].map(([status, n]) => ({ status, _count: { _all: n } }));
    },
  };
  return delegate;
}

export function createLibraryFakeDb() {
  const db: Record<string, any> = {
    note: table(() => ({ deletedAt: null, status: 'ready' })),
    noteVersion: table(),
    noteLibrary: table(() => ({ autoExtract: true, autoCommit: false })),
    noteLibraryFile: table(() => ({ importedVersion: null, noteId: null, contentHash: null })),
    noteImportBatch: table(() => ({ libraryId: null, status: 'running', finishedAt: null })),
    noteImportBatchItem: table(() => ({ fileId: null, noteId: null, noteVersion: null, diverged: false, failureReason: null, jobId: null })),
  };
  db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return db;
}
