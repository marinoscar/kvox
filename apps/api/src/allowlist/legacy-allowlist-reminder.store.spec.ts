import type { Prisma } from '@prisma/client';

import { LegacyAllowlistReminderStore } from './legacy-allowlist-reminder.store';

// PLATFORM-ADOPTION-SHIM(#465): raw SQL over allowed_emails.reminder_count / last_reminder_at.

function makeStore(rows: unknown[] = []) {
  const queryRaw = jest.fn().mockResolvedValue(rows);
  const store = new LegacyAllowlistReminderStore({ $queryRaw: queryRaw } as never);
  const statement = () => queryRaw.mock.calls[0][0] as Prisma.Sql;
  return { store, queryRaw, statement };
}

describe('LegacyAllowlistReminderStore', () => {
  describe('get', () => {
    it('maps rows by id and leaves unknown ids out', async () => {
      const at = new Date('2026-09-18T10:00:00Z');
      const { store, statement } = makeStore([
        { id: 'a', reminder_count: 2, last_reminder_at: at },
        { id: 'b', reminder_count: 0, last_reminder_at: null },
      ]);

      const result = await store.get(['a', 'b', 'c']);

      expect(result.get('a')).toEqual({ reminderCount: 2, lastReminderAt: at });
      expect(result.get('b')).toEqual({ reminderCount: 0, lastReminderAt: null });
      expect(result.has('c')).toBe(false);
      expect(statement().sql).toContain('FROM allowed_emails');
      expect(statement().values).toEqual(['a', 'b', 'c']);
    });

    it('does not query for no ids', async () => {
      const { store, queryRaw } = makeStore();

      expect((await store.get([])).size).toBe(0);
      expect(queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('increment', () => {
    it('increments in the database, never read-modify-write', async () => {
      const at = new Date('2026-09-18T10:00:00Z');
      const { store, queryRaw } = makeStore([{ reminder_count: 3, last_reminder_at: at }]);

      await expect(store.increment('a', at)).resolves.toEqual({ reminderCount: 3, lastReminderAt: at });

      // A tagged template: the call is (strings, ...values).
      const [strings, ...values] = queryRaw.mock.calls[0] as [string[], ...unknown[]];
      const sql = strings.join('?');
      expect(sql).toContain('reminder_count = reminder_count + 1');
      expect(sql).toContain('RETURNING reminder_count, last_reminder_at');
      expect(values).toEqual([at, 'a']);
    });

    it('throws for an entry that does not exist', async () => {
      const { store } = makeStore([]);

      await expect(store.increment('missing', new Date())).rejects.toThrow(/not found/);
    });
  });
});
