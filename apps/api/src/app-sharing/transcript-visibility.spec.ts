import '../app-registrations/sharing';
import {
  inViewerScope,
  type ViewerDb,
  principalOf,
  sharedTranscriptsWhere,
  transcriptViewer,
  transcriptVisibleSql,
} from './transcript-visibility';

// =============================================================================
// Which transcripts a user may see, for raw SQL (issue #485)
// =============================================================================
//
// The real-Postgres suites (`transcript-sharing.db.spec.ts`, `search.db.spec.ts`,
// `graph-read.db.spec.ts`) prove the condition against real rows. What is asserted
// here is its SHAPE: the platform's `accessibleSql` carries it, every value is a bind
// parameter, nothing reads `grants` by name outside that fragment, and the statement
// runs in the viewer's organization scope.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';

function fakeDb(shared: string[] = []) {
  const tx = { grant: { groupBy: jest.fn().mockResolvedValue(shared.map((resourceId) => ({ resourceId }))) }, $queryRaw: jest.fn() };
  const db = {
    organization: { findFirst: jest.fn().mockResolvedValue({ id: ORG }) },
    runInOrg: jest.fn(async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };

  // Typed `never`: a structural fake of the two members the helpers use.
  return { db: db as never as ViewerDb, tx };
}

describe('transcript visibility', () => {
  it('resolves the viewer in the default organization, with no groups', async () => {
    const { db } = fakeDb();

    const viewer = await transcriptViewer(db, USER);

    expect(viewer).toMatchObject({ userId: USER, orgId: ORG });
    expect(viewer.principal).toEqual(principalOf(USER, ORG, []));
    expect(viewer.principal.groups).toEqual([]);
  });

  it('builds a live-and-(owned-or-granted) condition with every value bound', async () => {
    const { db } = fakeDb();
    const viewer = await transcriptViewer(db, USER);

    const condition = transcriptVisibleSql(viewer, 't');
    const text = condition.sql.replace(/\s+/g, ' ');

    expect(text).toContain('t.deleted_at IS NULL');
    expect(text).toMatch(/"t"\."owner_id" = \?::uuid OR EXISTS/);
    expect(text).toContain('FROM grants g');
    expect(text).toContain('g.revoked_at IS NULL');
    expect(condition.values).toEqual(expect.arrayContaining([USER, ORG, 'transcript']));
    expect(text).not.toContain(USER);
    expect(text).not.toContain('transcript_shares');
  });

  it('refuses an alias that is not a plain identifier', async () => {
    const { db } = fakeDb();
    const viewer = await transcriptViewer(db, USER);

    expect(() => transcriptVisibleSql(viewer, 't; DROP TABLE transcripts')).toThrow();
  });

  it('runs a statement in the viewer\'s organization and user scope', async () => {
    const { db, tx } = fakeDb();
    const viewer = await transcriptViewer(db, USER);

    const seen = await inViewerScope(db, viewer, async (scoped) => scoped);

    expect(db.runInOrg).toHaveBeenCalledWith({ orgId: ORG, userId: USER }, expect.any(Function));
    expect(seen).toBe(tx);
  });

  describe('sharedTranscriptsWhere', () => {
    it('is the ids an active grant names, in the viewer\'s organization', async () => {
      const { db } = fakeDb(['a', 'b']);

      await expect(sharedTranscriptsWhere(db, USER)).resolves.toEqual({
        AND: [{ orgId: ORG }, { id: { in: ['a', 'b'] } }],
      });
    });

    it('is nothing when no grant names the viewer', async () => {
      const { db } = fakeDb([]);

      await expect(sharedTranscriptsWhere(db, USER)).resolves.toEqual({ id: { in: [] } });
    });

    it('switches to the EXISTS form past the platform\'s inline threshold, and reads the ids with one statement', async () => {
      const { db, tx } = fakeDb(Array.from({ length: 1001 }, (_, i) => `t-${i}`));
      tx.$queryRaw.mockResolvedValue([{ id: 'x' }, { id: 'y' }]);

      await expect(sharedTranscriptsWhere(db, USER)).resolves.toEqual({ id: { in: ['x', 'y'] } });
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      const statement = tx.$queryRaw.mock.calls[0][0] as { sql: string };
      expect(statement.sql).toContain('FROM transcripts r');
      expect(statement.sql).toContain('FROM grants g');
    });
  });
});
