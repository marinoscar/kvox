import { randomUUID } from 'node:crypto';

import type {
  KvoxNotesDb,
  KvoxNotesTx,
  NoteGenerationRow,
  NoteRow,
  NoteTemplateRow,
  NoteVersionRow,
} from '../data/notes-db.js';

// =============================================================================
// A tiny in-memory stand-in for the notes tables (issue #495, epic #491)
// =============================================================================
//
// Just enough of `KvoxNotesDb` for the generation pipeline: `notes`, `note_generations`,
// `note_versions` and `note_templates`, plain-equality `where` clauses plus `in`, `notIn`, `not`
// and `{ increment }` updates, and a `$transaction` that records whether a callback is running
// (`inTransaction`), which is what lets the conformance suite assert that the ready event is
// published AFTER the commit and never inside it. Nothing here pretends to be a database:
// a spec that needs joins, ordering or constraints runs on the real test host instead.
// =============================================================================

type Row = Record<string, unknown>;

/**
 * The in-memory notes database.
 *
 * @stability experimental
 */
export interface InMemoryNotesDb {
  /** The client to inject through `KVOX_PRISMA`. */
  readonly db: KvoxNotesDb;
  /** Whether a `$transaction` callback is running right now. */
  readonly inTransaction: () => boolean;
  /** `notes`. */
  readonly notes: NoteRow[];
  /** `note_generations`. */
  readonly generations: NoteGenerationRow[];
  /** `note_versions`. */
  readonly versions: NoteVersionRow[];
  /** `note_templates`. */
  readonly templates: NoteTemplateRow[];
}

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
    const condition = expected as Record<string, unknown>;

    if ('in' in condition) return (condition.in as unknown[]).includes(actual);
    if ('notIn' in condition) return !(condition.notIn as unknown[]).includes(actual);
    if ('not' in condition) return actual !== condition.not;
    if ('lt' in condition) return (actual as number | Date) < (condition.lt as number | Date);
    if ('gt' in condition) return (actual as number | Date) > (condition.gt as number | Date);
  }

  return actual === expected;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (where === undefined) return true;

  return Object.entries(where).every(([key, expected]) => matchesValue(row[key], expected));
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) {
      row[key] = (Number(row[key]) || 0) + Number((value as { increment: number }).increment);
    } else {
      row[key] = value;
    }
  }

  if ('updatedAt' in row) row.updatedAt = new Date();
}

function delegate<T extends object>(
  tableRows: T[],
  defaults: () => Partial<T>,
  relations: (row: T, args: Row) => T = (r) => r,
) {
  const rows = tableRows as unknown as Array<T & Row>;

  return {
    async findUnique(args: { where: Row; include?: Row }) {
      const found = rows.find((row) => matches(row, args.where));

      return found ? relations({ ...found }, args) : null;
    },
    async findFirst(args: { where?: Row; include?: Row } = {}) {
      const found = rows.find((row) => matches(row, args.where));

      return found ? relations({ ...found }, args) : null;
    },
    async findMany(args: { where?: Row; take?: number } = {}) {
      const found = rows.filter((row) => matches(row, args.where)).map((row) => ({ ...row }));

      return args.take === undefined ? found : found.slice(0, args.take);
    },
    async create(args: { data: Row }) {
      const row = { ...defaults(), ...args.data } as unknown as T & Row;

      rows.push(row);

      return { ...row };
    },
    async update(args: { where: Row; data: Row }) {
      const row = rows.find((candidate) => matches(candidate, args.where));

      if (!row) throw new Error('Record to update not found.');

      applyData(row, args.data);

      return { ...row };
    },
    async updateMany(args: { where?: Row; data: Row }) {
      const targets = rows.filter((row) => matches(row, args.where));

      for (const row of targets) applyData(row, args.data);

      return { count: targets.length };
    },
    async delete(args: { where: Row }) {
      const index = rows.findIndex((row) => matches(row, args.where));

      if (index < 0) throw new Error('Record to delete does not exist.');

      return rows.splice(index, 1)[0];
    },
    async deleteMany(args: { where?: Row } = {}) {
      const kept = rows.filter((row) => !matches(row, args.where));
      const count = rows.length - kept.length;

      rows.splice(0, rows.length, ...kept);

      return { count };
    },
    async count(args: { where?: Row } = {}) {
      return rows.filter((row) => matches(row, args.where)).length;
    },
  };
}

/**
 * Builds the in-memory notes database.
 *
 * @param seed - rows to start with.
 * @returns the client and the live tables.
 * @stability experimental
 */
export function createInMemoryNotesDb(
  seed: {
    notes?: NoteRow[];
    generations?: NoteGenerationRow[];
    versions?: NoteVersionRow[];
    templates?: NoteTemplateRow[];
  } = {},
): InMemoryNotesDb {
  const notes = seed.notes ?? [];
  const generations = seed.generations ?? [];
  const versions = seed.versions ?? [];
  const templates = seed.templates ?? [];
  let depth = 0;

  const now = (): Date => new Date();

  const delegates = {
    note: delegate<NoteRow>(notes, () => ({ id: randomUUID(), createdAt: now(), updatedAt: now(), deletedAt: null })),
    noteTemplate: {
      ...delegate<NoteTemplateRow>(templates, () => ({ id: randomUUID(), createdAt: now(), updatedAt: now() })),
      async upsert() {
        throw new Error('The in-memory notes database has no upsert; use the real test host.');
      },
    },
    noteGeneration: delegate<NoteGenerationRow>(
      generations,
      () => ({ id: randomUUID(), createdAt: now() }),
      (row, args) => {
        const include = (args.include ?? {}) as Row;

        return include.note
          ? { ...row, note: notes.find((note) => note.id === row.noteId) ?? null }
          : row;
      },
    ),
    noteVersion: delegate<NoteVersionRow>(versions, () => ({ id: randomUUID(), createdAt: now() })),
  };

  const unsupported = (name: string) => async (): Promise<never> => {
    throw new Error(`The in-memory notes database has no ${name}.`);
  };

  const tx = {
    ...delegates,
    userHiddenNoteTemplate: undefined,
    noteExport: undefined,
    transcript: undefined,
    transcriptVersion: undefined,
    $queryRaw: unsupported('$queryRaw'),
    $executeRaw: unsupported('$executeRaw'),
  } as unknown as KvoxNotesTx;

  const db = {
    ...tx,
    async $transaction(work: unknown): Promise<unknown> {
      if (typeof work !== 'function') return Promise.all(work as Promise<unknown>[]);

      depth += 1;

      try {
        return await (work as (client: KvoxNotesTx) => Promise<unknown>)(tx);
      } finally {
        depth -= 1;
      }
    },
  } as unknown as KvoxNotesDb;

  return { db, inTransaction: () => depth > 0, notes, generations, versions, templates };
}
