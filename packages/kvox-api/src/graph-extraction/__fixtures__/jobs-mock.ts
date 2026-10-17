import type { KvoxJobHandler } from '../../ports/index.js';

/**
 * A mocked job port for handler and service specs. `registered` lists the types a handler is
 * already registered for; `get` and `serverOnlyTypes` answer what the platform registry used
 * to, so a spec asserts on what registered and on node eligibility the same way.
 *
 * @param registered - job types that count as registered.
 * @returns the mock.
 */
export function jobsMock(registered: readonly string[] = []) {
  const handlers = new Map<string, Partial<KvoxJobHandler> & { type: string }>(
    registered.map((type) => [type, { type }]),
  );

  return {
    enqueue: jest.fn(async (_input?: unknown): Promise<{ id: string; deduplicated: boolean }> => ({
      id: 'job-1',
      deduplicated: false,
    })),
    enqueueWithin: jest.fn(async (_tx?: unknown, _input?: unknown): Promise<{ id: string; deduplicated: boolean }> => ({
      id: 'job-1',
      deduplicated: false,
    })),
    findActive: jest.fn(async (_query?: unknown): Promise<any[]> => []),
    findLatest: jest.fn(async (_query?: unknown): Promise<any> => null),
    runNow: jest.fn(async (_id?: string): Promise<boolean> => false),
    registerHandler: jest.fn((handler: KvoxJobHandler) => {
      handlers.set(handler.type, handler);
    }),
    isRegistered: jest.fn((type: string) => handlers.has(type)),
    onSettled: jest.fn(),
    tempPath: jest.fn(() => '/tmp/graph-spec'),
    /** The handler registered for a type, if any. */
    get: (type: string) => handlers.get(type),
    /** The registered types that declare no node members, i.e. can never run on a worker node. */
    serverOnlyTypes: () =>
      [...handlers.values()]
        .filter((handler) => handler.nodeResultSchema === undefined && handler.persistNodeResult === undefined)
        .map((handler) => handler.type),
  };
}
