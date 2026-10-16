import { UserAiKeysService } from '@marinoscar/platform-api/ai';

import { AiUserKeysPurger } from './ai-user-keys.purger';

// =============================================================================
// AiUserKeysPurger (issue #475)
// =============================================================================
//
// The user-data purge erases a user's AI keys through the platform's
// `UserAiKeysService`: one `remove` per provider the user has a key for, and
// nothing for a provider they never configured.
// =============================================================================

const USER_ID = 'user-1';

function harness(providers: string[]) {
  const keys = { remove: jest.fn().mockResolvedValue(undefined) };
  const moduleRef = { get: jest.fn().mockReturnValue(keys) };
  const prisma = {
    userAiKey: {
      findMany: jest.fn().mockResolvedValue(providers.map((provider) => ({ provider }))),
      count: jest.fn().mockResolvedValue(providers.length),
    },
  };
  const purger = new AiUserKeysPurger(moduleRef as never, prisma as never);

  return { purger, keys, moduleRef, prisma };
}

describe('AiUserKeysPurger', () => {
  it('resolves the platform service anywhere in the application graph', async () => {
    const { purger, moduleRef } = harness(['openai']);

    await purger.removeAll(USER_ID);

    expect(moduleRef.get).toHaveBeenCalledWith(UserAiKeysService, { strict: false });
  });

  it('removes one key per stored provider and returns how many', async () => {
    const { purger, keys } = harness(['openai', 'anthropic']);

    await expect(purger.removeAll(USER_ID)).resolves.toBe(2);

    expect(keys.remove).toHaveBeenCalledWith(USER_ID, 'openai');
    expect(keys.remove).toHaveBeenCalledWith(USER_ID, 'anthropic');
  });

  it('reads the stored rows, so keys saved before AI was switched off are still erased', async () => {
    const { purger, prisma } = harness(['openai']);

    await purger.removeAll(USER_ID);

    expect(prisma.userAiKey.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      select: { provider: true },
    });
  });

  it('counts the stored keys', async () => {
    const { purger } = harness(['openai', 'anthropic']);

    await expect(purger.count(USER_ID)).resolves.toBe(2);
  });

  it('removes nothing for a user with no keys', async () => {
    const { purger, keys } = harness([]);

    await expect(purger.removeAll(USER_ID)).resolves.toBe(0);
    expect(keys.remove).not.toHaveBeenCalled();
  });
});
