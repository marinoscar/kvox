import { ProposalCommitService } from './proposal-commit.service.js';

/** #591: `graph.changed` is emitted once, after the commit transaction committed. */
const OWNER = '0a000000-0000-4000-8000-000000000001';
const P = '0b000000-0000-4000-8000-000000000001';
const user = { id: OWNER, permissions: [] } as never;

function harness(txImpl?: (fn: (tx: unknown) => unknown) => unknown) {
  const tx = {};
  const prisma = { $transaction: jest.fn(txImpl ?? (async (fn: (t: unknown) => unknown) => fn(tx))) };
  const events = { emit: jest.fn(), subscribe: jest.fn() };
  const proposals = { summary: jest.fn(async () => ({ id: P })) };
  const service = new ProposalCommitService(
    prisma as never,
    { require: jest.fn(async () => undefined) } as never,
    { effectiveSchemaFor: jest.fn(async () => ({})) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { enqueue: jest.fn() } as never,
    {} as never,
    proposals as never,
    {} as never,
    events as never,
  );
  const outcome = (kind: string) => ({ kind, result: { created: { entities: 0, relations: 0, items: 0 }, linked: 0 }, merges: [] });
  const stub = (kind: string) => {
    jest.spyOn(service as any, 'commitIn').mockResolvedValue(outcome(kind));
    jest.spyOn(service as any, 'afterCommit').mockResolvedValue(undefined);
  };
  return { service, prisma, events, stub };
}

describe('ProposalCommitService graph.changed (#591)', () => {
  it("emits exactly one { ownerId, reason: 'commit' } for an extraction proposal", async () => {
    const { service, events, stub } = harness();
    stub('extraction');
    await service.commit(user, P);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('graph.changed', { ownerId: OWNER, reason: 'commit' });
  });

  it("emits reason 'import' for an import proposal", async () => {
    const { service, events, stub } = harness();
    stub('import');
    await service.commit(user, P);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('graph.changed', { ownerId: OWNER, reason: 'import' });
  });

  it('emits after afterCommit ran', async () => {
    const { service, events, stub } = harness();
    stub('extraction');
    const order: string[] = [];
    (service as any).afterCommit.mockImplementation(async () => { order.push('after'); });
    events.emit.mockImplementation(() => { order.push('emit'); });
    await service.commit(user, P);
    expect(order).toEqual(['after', 'emit']);
  });

  it('emits nothing when the transaction rejects (rolled back), and the call rejects', async () => {
    const { service, events, stub } = harness(async () => { throw new Error('rollback'); });
    stub('extraction');
    await expect(service.commit(user, P)).rejects.toThrow();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does not fail the commit when the emit throws', async () => {
    const { service, events, stub } = harness();
    stub('extraction');
    events.emit.mockImplementation(() => { throw new Error('listener down'); });
    await expect(service.commit(user, P)).resolves.toEqual(expect.objectContaining({ proposal: { id: P } }));
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});
