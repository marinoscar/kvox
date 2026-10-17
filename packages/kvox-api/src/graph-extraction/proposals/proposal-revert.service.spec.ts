import { ProposalRevertService } from './proposal-revert.service.js';

/** #591: `graph.changed` ('revert') is emitted once, after the revert transaction committed. */
const OWNER = '0a000000-0000-4000-8000-000000000001';
const P = '0b000000-0000-4000-8000-000000000001';
const user = { id: OWNER, permissions: [] } as never;

function harness(txImpl?: (fn: (tx: unknown) => unknown) => unknown) {
  const prisma = { $transaction: jest.fn(txImpl ?? (async (fn: (t: unknown) => unknown) => fn({}))) };
  const events = { emit: jest.fn(), subscribe: jest.fn() };
  const service = new ProposalRevertService(
    prisma as never,
    { require: jest.fn(async () => undefined) } as never,
    {} as never,
    {} as never,
    { summary: jest.fn(async () => ({ id: P })) } as never,
    {} as never,
    events as never,
  );
  jest.spyOn(service as any, 'revertIn').mockResolvedValue({ result: { reverted: 1, kept: [] } });
  jest.spyOn(service as any, 'afterRevert').mockResolvedValue(undefined);
  return { service, events };
}

describe('ProposalRevertService graph.changed (#591)', () => {
  it("emits exactly one 'revert' event after the transaction and afterRevert", async () => {
    const { service, events } = harness();
    const order: string[] = [];
    (service as any).afterRevert.mockImplementation(async () => { order.push('after'); });
    events.emit.mockImplementation(() => { order.push('emit'); });
    await service.revert(user, P, false);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('graph.changed', { ownerId: OWNER, reason: 'revert' });
    expect(order).toEqual(['after', 'emit']);
  });

  it('emits nothing when the transaction rejects, and the call rejects', async () => {
    const { service, events } = harness(async () => { throw new Error('rollback'); });
    await expect(service.revert(user, P, false)).rejects.toThrow();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does not fail the revert when the emit throws', async () => {
    const { service, events } = harness();
    events.emit.mockImplementation(() => { throw new Error('listener down'); });
    await expect(service.revert(user, P, false)).resolves.toBeDefined();
  });
});
