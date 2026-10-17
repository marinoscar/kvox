import { MergeService } from './merge.service.js';

/** #591: MergeService emits `graph.changed` only for a transaction it opened itself. */
const OWNER = '0a000000-0000-4000-8000-000000000001';
const A = '0f000000-0000-4000-8000-00000000000a';
const B = '0f000000-0000-4000-8000-00000000000b';
const mergeInput = { ownerId: OWNER, mergedId: A, survivorId: B, actorId: OWNER, source: 'manual' } as const;
const reverseInput = { ownerId: OWNER, mergeId: '0c000000-0000-4000-8000-000000000001', actorId: OWNER };

function harness(txImpl?: (fn: (tx: unknown) => unknown) => unknown) {
  const tx = { marker: 'tx' };
  const prisma = { $transaction: jest.fn(txImpl ?? (async (fn: (t: unknown) => unknown) => fn(tx))) };
  const events = { emit: jest.fn(), subscribe: jest.fn() };
  const service = new MergeService(prisma as never, {} as never, {} as never, {} as never, {} as never, events as never);
  const merged = { merge: { id: 'm', survivorId: B, mergedId: A } };
  const reversed = { merge: { id: 'm', survivorId: B, mergedId: A }, skipped: [] };
  jest.spyOn(service as any, 'mergeIn').mockResolvedValue(merged);
  jest.spyOn(service as any, 'reverseIn').mockResolvedValue(reversed);
  jest.spyOn(service, 'afterMerge').mockResolvedValue(undefined);
  jest.spyOn(service, 'afterReverse').mockResolvedValue(undefined);
  return { service, prisma, events, tx };
}

describe('MergeService graph.changed (#591)', () => {
  describe('merge', () => {
    it("emits one 'merge' when it opens its own transaction", async () => {
      const { service, events } = harness();
      await service.merge(mergeInput);
      expect(events.emit).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith('graph.changed', { ownerId: OWNER, reason: 'merge' });
    });

    it('emits nothing with a caller tx', async () => {
      const { service, events, prisma, tx } = harness();
      await service.merge(mergeInput, tx as never);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('emits nothing when its transaction rejects', async () => {
      const { service, events } = harness(async () => { throw new Error('rollback'); });
      await expect(service.merge(mergeInput)).rejects.toThrow('rollback');
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('still emits when afterMerge fails, and the failure propagates', async () => {
      const { service, events } = harness();
      (service.afterMerge as jest.Mock).mockRejectedValue(new Error('audit down'));
      await expect(service.merge(mergeInput)).rejects.toThrow('audit down');
      expect(events.emit).toHaveBeenCalledTimes(1);
    });

    it('does not fail the merge when the emit throws', async () => {
      const { service, events } = harness();
      events.emit.mockImplementation(() => { throw new Error('listener down'); });
      await expect(service.merge(mergeInput)).resolves.toBeDefined();
    });
  });

  describe('reverse', () => {
    it("emits one 'merge_reversed' when it opens its own transaction", async () => {
      const { service, events } = harness();
      await service.reverse(reverseInput);
      expect(events.emit).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith('graph.changed', { ownerId: OWNER, reason: 'merge_reversed' });
    });

    it('emits nothing with a caller tx', async () => {
      const { service, events, prisma, tx } = harness();
      await service.reverse(reverseInput, tx as never);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('emits nothing when its transaction rejects', async () => {
      const { service, events } = harness(async () => { throw new Error('rollback'); });
      await expect(service.reverse(reverseInput)).rejects.toThrow('rollback');
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
