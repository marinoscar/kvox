import { AiError } from '@marinoscar/platform-ai-providers';

import { createSdkCopilotTransport } from './copilot-transport.js';
import { copilotSessionConfig } from './copilot-adapter.js';

// =============================================================================
// createSdkCopilotTransport (#581): the one place the SDK is loaded
// =============================================================================
//
// The SDK is an OPTIONAL peer and is not installed in this repository, so the
// first block proves the missing-SDK path against reality. The second block
// installs a VIRTUAL stand-in for `@github/copilot-sdk` to prove what the
// transport asks of the real client: `mode: 'empty'`, the user's own sign-in, the
// two directories, no token option, one client for every call, and the tripwire's
// tool list.
// =============================================================================

const OPTIONS = { baseDirectory: '/data/copilot', workingDirectory: '/tmp/empty' };

describe('createSdkCopilotTransport without the SDK installed', () => {
  it('requires both directories', () => {
    expect(() => createSdkCopilotTransport({ baseDirectory: '', workingDirectory: '/x' })).toThrow(/baseDirectory/);
    expect(() => createSdkCopilotTransport({ baseDirectory: '/x', workingDirectory: '' })).toThrow(/workingDirectory/);
    expect(() => createSdkCopilotTransport(undefined as never)).toThrow();
  });

  it('builds without loading the SDK, and exposes the working directory', () => {
    const transport = createSdkCopilotTransport(OPTIONS);
    expect(transport.workingDirectory).toBe('/tmp/empty');
  });

  it('answers AI_PROVIDER_UNAVAILABLE naming the optional peer on the first call', async () => {
    const transport = createSdkCopilotTransport(OPTIONS);
    for (const call of [() => transport.getAuthStatus(), () => transport.listModels(), () => transport.deleteSession('s')]) {
      const error = await call().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(AiError.isAiError(error)).toBe(true);
      expect((error as AiError).code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect((error as AiError).message).toBe('The GitHub Copilot SDK is not installed (optional peer @github/copilot-sdk).');
    }
  });

  it('stop() is a no-op before any client exists', async () => {
    await expect(createSdkCopilotTransport(OPTIONS).stop?.()).resolves.toBeUndefined();
  });
});

describe('createSdkCopilotTransport over a stand-in SDK', () => {
  interface FakeSession {
    sessionId: string;
    on: jest.Mock;
    send: jest.Mock;
    abort: jest.Mock;
    disconnect: jest.Mock;
    rpc: { tools: { initializeAndValidate?: jest.Mock; getCurrentMetadata: jest.Mock } };
  }
  let constructed: Array<Record<string, unknown>>;
  let client: {
    start: jest.Mock;
    stop: jest.Mock;
    getAuthStatus: jest.Mock;
    listModels: jest.Mock;
    createSession: jest.Mock;
    deleteSession: jest.Mock;
  };
  let session: FakeSession;

  beforeEach(() => {
    constructed = [];
    session = {
      sessionId: 'sdk-session-1',
      on: jest.fn(() => () => undefined),
      send: jest.fn(async () => 'message-1'),
      abort: jest.fn(async () => undefined),
      disconnect: jest.fn(async () => undefined),
      rpc: {
        tools: {
          initializeAndValidate: jest.fn(async () => ({})),
          getCurrentMetadata: jest.fn(async () => ({ tools: [] as Array<{ name: string }> | null })),
        },
      },
    };
    client = {
      start: jest.fn(async () => undefined),
      stop: jest.fn(async () => []),
      getAuthStatus: jest.fn(async () => ({
        isAuthenticated: true,
        login: 'octocat',
        authType: 'user',
        statusMessage: 'secret-ish status text',
        host: 'github.com',
      })),
      listModels: jest.fn(async () => [{ id: 'gpt-5-mini' }]),
      createSession: jest.fn(async () => session),
      deleteSession: jest.fn(async () => undefined),
    };
    jest.resetModules();
    jest.doMock(
      '@github/copilot-sdk',
      () => ({
        CopilotClient: class {
          constructor(options: Record<string, unknown>) {
            constructed.push(options);
            return client as never;
          }
        },
      }),
      { virtual: true },
    );
  });

  afterEach(() => {
    jest.dontMock('@github/copilot-sdk');
    jest.resetModules();
  });

  const load = (): typeof import('./copilot-transport.js') => jest.requireActual('./copilot-transport.js');

  it('builds ONE client lazily with mode empty, the user own sign-in and no token', async () => {
    const transport = load().createSdkCopilotTransport(OPTIONS);
    expect(constructed).toHaveLength(0);

    await transport.getAuthStatus();
    await transport.listModels();
    await transport.createSession(copilotSessionConfig({ model: 'm', instructions: '', workingDirectory: '/tmp/empty' }));
    await transport.deleteSession('x');

    expect(constructed).toEqual([
      { mode: 'empty', baseDirectory: '/data/copilot', workingDirectory: '/tmp/empty', useLoggedInUser: true, logLevel: 'none' },
    ]);
    expect(Object.keys(constructed[0]).filter((key) => /token/i.test(key))).toEqual([]);
    expect(client.start).toHaveBeenCalledTimes(1);
  });

  it('passes a log level through', async () => {
    await load().createSdkCopilotTransport({ ...OPTIONS, logLevel: 'error' }).getAuthStatus();
    expect(constructed[0].logLevel).toBe('error');
  });

  it('reports only the sign-in fields, never the runtime status message', async () => {
    const status = await load().createSdkCopilotTransport(OPTIONS).getAuthStatus();
    expect(status).toEqual({ isAuthenticated: true, login: 'octocat', authType: 'user' });
  });

  it('retries a failed start on the next call', async () => {
    client.start.mockRejectedValueOnce(new Error('cli not found'));
    const transport = load().createSdkCopilotTransport(OPTIONS);
    await expect(transport.getAuthStatus()).rejects.toThrow('cli not found');
    await expect(transport.getAuthStatus()).resolves.toMatchObject({ isAuthenticated: true });
    expect(client.start).toHaveBeenCalledTimes(2);
  });

  it('creates a session with exactly the config it was given, and wraps the SDK session', async () => {
    const transport = load().createSdkCopilotTransport(OPTIONS);
    const config = copilotSessionConfig({ model: 'gpt-5-mini', instructions: 'Be brief.', workingDirectory: '/tmp/empty' });

    const handle = await transport.createSession(config);

    expect(client.createSession).toHaveBeenCalledWith(config);
    expect(handle.sessionId).toBe('sdk-session-1');
    await handle.send({ prompt: 'p', responseSchema: { type: 'object' } });
    expect(session.send).toHaveBeenCalledWith({ prompt: 'p', responseSchema: { type: 'object' } });
    await handle.abort();
    await handle.disconnect();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    await transport.deleteSession('sdk-session-1');
    expect(client.deleteSession).toHaveBeenCalledWith('sdk-session-1');
  });

  it('reads the tool names for the tripwire after building the list: empty, named and null', async () => {
    const handle = await load().createSdkCopilotTransport(OPTIONS).createSession(
      copilotSessionConfig({ model: 'm', instructions: '', workingDirectory: '/tmp/empty' }),
    );

    await expect(handle.currentToolNames()).resolves.toEqual([]);
    expect(session.rpc.tools.initializeAndValidate).toHaveBeenCalled();

    session.rpc.tools.getCurrentMetadata.mockResolvedValueOnce({ tools: [{ name: 'bash' }, { name: 'view' }] });
    await expect(handle.currentToolNames()).resolves.toEqual(['bash', 'view']);

    session.rpc.tools.getCurrentMetadata.mockResolvedValueOnce({ tools: null });
    await expect(handle.currentToolNames()).resolves.toBeNull();
  });

  it('still lists the tools when the runtime refuses to initialize the list', async () => {
    session.rpc.tools.initializeAndValidate!.mockRejectedValue(new Error('unsupported'));
    session.rpc.tools.getCurrentMetadata.mockResolvedValue({ tools: [{ name: 'bash' }] });
    const handle = await load().createSdkCopilotTransport(OPTIONS).createSession(
      copilotSessionConfig({ model: 'm', instructions: '', workingDirectory: '/tmp/empty' }),
    );
    await expect(handle.currentToolNames()).resolves.toEqual(['bash']);
  });

  it('stops the client once and builds a new one afterwards', async () => {
    const transport = load().createSdkCopilotTransport(OPTIONS);
    await transport.getAuthStatus();
    await transport.stop?.();
    expect(client.stop).toHaveBeenCalledTimes(1);
    await transport.getAuthStatus();
    expect(constructed).toHaveLength(2);
  });

  it('reports an SDK that fails to load for another reason, redacted', async () => {
    jest.resetModules();
    jest.doMock(
      '@github/copilot-sdk',
      () => {
        throw new Error('SyntaxError in sdk while holding gho_PLANTEDcopilotTOKEN0000000000');
      },
      { virtual: true },
    );
    const error = await load().createSdkCopilotTransport(OPTIONS).getAuthStatus().then(
      () => undefined,
      (e: unknown) => e as AiError,
    );
    expect(error?.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(error?.message).toMatch(/could not be loaded/);
    expect(error?.message).not.toContain('PLANTEDcopilotTOKEN');
  });
});
