import { AiError } from '@marinoscar/platform-ai-providers';

import { createCopilotAdapter } from './copilot-adapter.js';
import { createCopilotMockTransport, type CopilotMockTransport } from './copilot-mock-transport.js';
import type { CopilotTransport } from './copilot-transport.js';

// =============================================================================
// Signing in and out of GitHub Copilot (#630)
// =============================================================================
//
// Part 1: the adapter over the scripted mock transport. Part 2: the SDK transport
// over a VIRTUAL stand-in for `@github/copilot-sdk` that speaks the experimental
// account RPCs the way SDK 1.0.22 does (`session.rpc.accounts.login.begin/advance/
// cancel`, `accounts.set({ command: { kind: 'logout' } })`; verified against the
// real runtime for begin, a blocking advance, cancel and logout: see SPIKE.md).
// =============================================================================

// Duck-typed on purpose: the stand-in SDK block resets the module registry, so the
// transport's `AiError` class is not this file's.
const isAiErrorLike = (error: unknown): error is AiError =>
  error instanceof Error && String((error as { code?: unknown }).code ?? '').startsWith('AI_');

const reasonOf = (error: unknown): unknown => (isAiErrorLike(error) ? error.toJSON().details.signInReason : undefined);

/** The rejection of a promise (the test fails when it resolves). */
async function rejection(promise: Promise<unknown>): Promise<AiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isAiErrorLike(error)).toBe(true);
  return error as AiError;
}

describe('copilot adapter sign-in over the mock transport', () => {
  function build(options: { signedIn?: boolean } = { signedIn: false }) {
    const mock = createCopilotMockTransport(options);
    const adapter = createCopilotAdapter({ optIn: true, transport: mock });
    return { mock, adapter };
  }

  it('start() returns the challenge, wait() resolves to { signedIn: true, login }', async () => {
    const { mock, adapter } = build();
    mock.scriptSignIn({
      challenge: { kind: 'device', userCode: 'WXYZ-9876', verificationUri: 'https://github.com/login/device', expiresAt: '2026-01-01T00:05:00.000Z' },
      login: 'hubot',
    });

    expect((await adapter.authStatus()).signedIn).toBe(false);
    await expect(adapter.signIn.start()).resolves.toEqual({
      kind: 'device',
      userCode: 'WXYZ-9876',
      verificationUri: 'https://github.com/login/device',
      expiresAt: '2026-01-01T00:05:00.000Z',
    });
    await expect(adapter.signIn.wait()).resolves.toEqual({ signedIn: true, login: 'hubot' });
    await expect(adapter.authStatus()).resolves.toEqual({ signedIn: true, login: 'hubot' });
    expect(mock.signInCalls()).toEqual({ started: 1, waited: 1, signedOut: 0, aborted: 0 });
  });

  it('passes a browser challenge through', async () => {
    const { mock, adapter } = build();
    mock.scriptSignIn({ challenge: { kind: 'browser', url: 'https://github.com/login/oauth/authorize?client_id=x' } });
    await expect(adapter.signIn.start()).resolves.toEqual({ kind: 'browser', url: 'https://github.com/login/oauth/authorize?client_id=x' });
  });

  it('signOut() returns to signed out', async () => {
    const { mock, adapter } = build({ signedIn: true });
    expect((await adapter.authStatus()).signedIn).toBe(true);
    await adapter.signOut();
    await expect(adapter.authStatus()).resolves.toEqual({ signedIn: false, login: null });
    // Calls made while signed out are refused until the user signs in again.
    await expect(rejection(adapter.responses.create({ model: 'gpt-5-mini', input: 'Hi' }, { apiKey: 'k', requestId: 'r' }))).resolves.toMatchObject({
      code: 'AI_KEY_REQUIRED',
    });
    expect(mock.signInCalls().signedOut).toBe(1);
  });

  it('an expired sign-in rejects with AI_KEY_REQUIRED and signInReason sign_in_expired, and stays signed out', async () => {
    const { mock, adapter } = build();
    mock.scriptSignIn({ outcome: 'expired' });
    await adapter.signIn.start();
    const error = await rejection(adapter.signIn.wait());
    expect(error.code).toBe('AI_KEY_REQUIRED');
    expect(reasonOf(error)).toBe('sign_in_expired');
    expect((await adapter.authStatus()).signedIn).toBe(false);
  });

  it('a cancelled sign-in rejects with AI_KEY_REQUIRED and signInReason sign_in_cancelled', async () => {
    const { mock, adapter } = build();
    mock.scriptSignIn({ outcome: 'cancelled' });
    await adapter.signIn.start();
    const error = await rejection(adapter.signIn.wait());
    expect(error.code).toBe('AI_KEY_REQUIRED');
    expect(reasonOf(error)).toBe('sign_in_cancelled');
  });

  it('an abort signal cancels a pending wait, typed, and tells the transport', async () => {
    const { mock, adapter } = build();
    mock.scriptSignIn({ outcome: 'pending' });
    await adapter.signIn.start();
    const controller = new AbortController();
    const waiting = rejection(adapter.signIn.wait(controller.signal));
    setImmediate(() => controller.abort(new Error('user closed the dialog')));
    const error = await waiting;
    expect(error.code).toBe('AI_KEY_REQUIRED');
    expect(reasonOf(error)).toBe('sign_in_cancelled');
    expect(mock.signInCalls().aborted).toBe(1);
    expect((await adapter.authStatus()).signedIn).toBe(false);
  });

  it('an already aborted signal rejects at once as cancelled', async () => {
    const { adapter } = build();
    await adapter.signIn.start();
    const error = await rejection(adapter.signIn.wait(AbortSignal.abort()));
    expect(reasonOf(error)).toBe('sign_in_cancelled');
  });

  it('wait() without start() is a typed error, not a hang', async () => {
    const { adapter } = build();
    const error = await rejection(adapter.signIn.wait());
    expect(error.code).toBe('AI_KEY_REQUIRED');
    expect(reasonOf(error)).toBe('sign_in_not_started');
  });

  it('a runtime failure becomes a platform AiError', async () => {
    const { mock, adapter } = build();
    mock.scriptSignIn({ startError: new Error('runtime exploded') });
    expect((await rejection(adapter.signIn.start())).code).toBe('AI_PROVIDER_UNAVAILABLE');
    mock.scriptSignIn({ waitError: new Error('runtime exploded') });
    await adapter.signIn.start();
    expect((await rejection(adapter.signIn.wait())).code).toBe('AI_PROVIDER_UNAVAILABLE');
  });

  it('a transport that reports "not signed in" after the wait is a failed sign-in', async () => {
    const mock = createCopilotMockTransport({ signedIn: false });
    const transport: CopilotTransport = { ...mock, waitForSignIn: async () => ({ isAuthenticated: false }) };
    const adapter = createCopilotAdapter({ optIn: true, transport });
    const error = await rejection(adapter.signIn.wait());
    expect(reasonOf(error)).toBe('sign_in_failed');
  });

  it('returns only documented fields, whatever the transport hands back', async () => {
    const mock = createCopilotMockTransport({ signedIn: false });
    const transport: CopilotTransport = {
      ...mock,
      startSignIn: async () => ({ kind: 'browser', url: 'https://github.com/x', extra: 'nope' }) as never,
      waitForSignIn: async () => ({ isAuthenticated: true, login: 'octocat', token: 'nope', statusMessage: 'nope' }) as never,
    };
    const adapter = createCopilotAdapter({ optIn: true, transport });
    expect(await adapter.signIn.start()).toEqual({ kind: 'browser', url: 'https://github.com/x' });
    expect(await adapter.signIn.wait()).toEqual({ signedIn: true, login: 'octocat' });
  });

  it('a signOut failure becomes a platform AiError', async () => {
    const mock: CopilotMockTransport = createCopilotMockTransport();
    const adapter = createCopilotAdapter({ optIn: true, transport: { ...mock, signOut: async () => Promise.reject(new Error('boom')) } });
    expect((await rejection(adapter.signOut())).code).toBe('AI_PROVIDER_UNAVAILABLE');
  });

  it('reset() forgets the script and the counters', async () => {
    const { mock, adapter } = build();
    mock.scriptSignIn({ outcome: 'expired' });
    await adapter.signIn.start();
    mock.reset();
    expect(mock.signInCalls()).toEqual({ started: 0, waited: 0, signedOut: 0, aborted: 0 });
    await adapter.signIn.start();
    await expect(adapter.signIn.wait()).resolves.toMatchObject({ signedIn: true });
  });
});

// -----------------------------------------------------------------------------
// The SDK transport over a stand-in SDK
// -----------------------------------------------------------------------------

describe('createSdkCopilotTransport sign-in over a stand-in SDK', () => {
  const OPTIONS = { baseDirectory: '/data/copilot', workingDirectory: '/tmp/empty' };
  const AUTHORIZE = 'https://github.com/login/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A41517%2Fcallback&state=s&code_challenge=c';

  type Step = { kind: string; [key: string]: unknown };
  interface Deferred {
    resolve(step: Step): void;
    reject(error: Error): void;
    promise: Promise<Step>;
  }
  const deferred = (): Deferred => {
    let resolve!: (step: Step) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Step>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { resolve, reject, promise };
  };

  let sessions: Array<{ sessionId: string; config: Record<string, unknown>; disconnect: jest.Mock; login: { begin: jest.Mock; advance: jest.Mock; cancel: jest.Mock }; set: jest.Mock }>;
  let client: { start: jest.Mock; stop: jest.Mock; getAuthStatus: jest.Mock; listModels: jest.Mock; createSession: jest.Mock; deleteSession: jest.Mock };
  let pending: Deferred[];
  let beginStep: Step;

  beforeEach(() => {
    sessions = [];
    pending = [];
    beginStep = { kind: 'open-url', url: AUTHORIZE };
    client = {
      start: jest.fn(async () => undefined),
      stop: jest.fn(async () => []),
      getAuthStatus: jest.fn(async () => ({ isAuthenticated: true, login: 'octocat', authType: 'user', statusMessage: 'private text' })),
      listModels: jest.fn(async () => []),
      createSession: jest.fn(async (config: Record<string, unknown>) => {
        const login = {
          begin: jest.fn(async () => ({ flowId: 'flow-1', step: beginStep })),
          advance: jest.fn(() => {
            const d = deferred();
            pending.push(d);
            return d.promise;
          }),
          // The real runtime rejects the blocked advance with "Login cancelled".
          cancel: jest.fn(async () => {
            pending.shift()?.reject(new Error('Request session.accounts.login.advance failed with message: GenericFailure, Login cancelled'));
          }),
        };
        const session = {
          sessionId: `acct-${sessions.length + 1}`,
          config,
          disconnect: jest.fn(async () => undefined),
          login,
          set: jest.fn(async () => ({ ok: true, moreUsers: false })),
          rpc: { tools: { getCurrentMetadata: jest.fn() }, accounts: { login, set: undefined as unknown } },
        };
        session.rpc.accounts.set = session.set;
        sessions.push(session);
        return session;
      }),
      deleteSession: jest.fn(async () => undefined),
    };
    jest.resetModules();
    jest.doMock('@github/copilot-sdk', () => ({ CopilotClient: class { constructor() { return client as never; } } }), { virtual: true });
  });

  afterEach(() => {
    jest.dontMock('@github/copilot-sdk');
    jest.resetModules();
    jest.useRealTimers();
  });

  const load = (options: { signInTimeoutMs?: number } = {}): CopilotTransport =>
    (jest.requireActual('./copilot-transport.js') as typeof import('./copilot-transport.js')).createSdkCopilotTransport({ ...OPTIONS, ...options });
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('startSignIn opens a zero-tool account session, begins the github.com flow and returns only the address', async () => {
    const transport = load();
    const challenge = await transport.startSignIn();

    expect(challenge).toEqual({ kind: 'browser', url: AUTHORIZE });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].login.begin).toHaveBeenCalledWith({ kind: 'githubDotCom' });
    expect(sessions[0].config).toMatchObject({ availableTools: [], enableSkills: false, workingDirectory: '/tmp/empty' });
    expect(sessions[0].config).not.toHaveProperty('model');
    expect(Object.keys(sessions[0].config).filter((key) => /token/i.test(key))).toEqual([]);
    expect((sessions[0].config.onPermissionRequest as () => unknown)()).toEqual({ kind: 'reject' });
  });

  it('refuses a sign-in address that is not https on github.com', async () => {
    for (const url of ['http://github.com/login', 'https://evil.example/login', 'javascript:alert(1)', 'not a url']) {
      beginStep = { kind: 'open-url', url };
      const error = await rejection(load().startSignIn());
      expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(error.message).not.toContain('evil.example');
    }
    // Each refused flow's session was released.
    expect(client.deleteSession).toHaveBeenCalledTimes(sessions.length);
  });

  it('a first step that is not an address is a typed failure', async () => {
    beginStep = { kind: 'input-required', prompt: 'host?' };
    expect(reasonOf(await rejection(load().startSignIn()))).toBe('sign_in_needs_input');
    beginStep = { kind: 'error', message: 'boom' };
    expect((await rejection(load().startSignIn())).code).toBe('AI_PROVIDER_UNAVAILABLE');
  });

  it('waitForSignIn resolves once the flow completes, with only the whitelisted status, and releases the session', async () => {
    const transport = load();
    await transport.startSignIn();
    const waiting = transport.waitForSignIn();
    await tick();
    pending[0].resolve({ kind: 'completed', result: { status: 'completed', login: 'flow-login', host: 'github.com', token: 'gho_SHOULDNOTAPPEARxxxxxxxxxxxx' } });

    await expect(waiting).resolves.toEqual({ isAuthenticated: true, login: 'octocat', authType: 'user' });
    expect(sessions[0].login.advance).toHaveBeenCalledWith({ flowId: 'flow-1' });
    expect(sessions[0].disconnect).toHaveBeenCalled();
    expect(client.deleteSession).toHaveBeenCalledWith('acct-1');
  });

  it('keeps following awaiting steps', async () => {
    const transport = load();
    await transport.startSignIn();
    const waiting = transport.waitForSignIn();
    await tick();
    pending[0].resolve({ kind: 'awaiting' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pending).toHaveLength(2);
    pending[1].resolve({ kind: 'completed', result: { status: 'completed', login: 'late' } });
    await expect(waiting).resolves.toMatchObject({ isAuthenticated: true });
  });

  it('uses the login of the flow when the status call fails', async () => {
    const transport = load();
    await transport.startSignIn();
    client.getAuthStatus.mockRejectedValue(new Error('down'));
    const waiting = transport.waitForSignIn();
    await tick();
    pending[0].resolve({ kind: 'completed', result: { status: 'completed', login: 'flow-login' } });
    await expect(waiting).resolves.toEqual({ isAuthenticated: true, login: 'flow-login' });
  });

  it('a user who cancels in the runtime (advance rejects "Login cancelled") is a cancelled sign-in', async () => {
    const transport = load();
    await transport.startSignIn();
    const waiting = rejection(transport.waitForSignIn());
    await tick();
    pending[0].reject(new Error('GenericFailure, Login cancelled'));
    expect(reasonOf(await waiting)).toBe('sign_in_cancelled');
    expect(client.deleteSession).toHaveBeenCalledWith('acct-1');
  });

  it('an abort signal cancels the runtime flow and rejects as cancelled', async () => {
    const transport = load();
    await transport.startSignIn();
    const controller = new AbortController();
    const waiting = rejection(transport.waitForSignIn(controller.signal));
    await tick();
    controller.abort();
    expect(reasonOf(await waiting)).toBe('sign_in_cancelled');
    expect(sessions[0].login.cancel).toHaveBeenCalledWith({ flowId: 'flow-1' });
    expect(client.deleteSession).toHaveBeenCalledWith('acct-1');
  });

  it('a signal aborted before the wait cancels the flow without advancing it', async () => {
    const transport = load();
    await transport.startSignIn();
    expect(reasonOf(await rejection(transport.waitForSignIn(AbortSignal.abort())))).toBe('sign_in_cancelled');
    expect(sessions[0].login.advance).not.toHaveBeenCalled();
    expect(sessions[0].login.cancel).toHaveBeenCalled();
  });

  it('the sign-in expires after signInTimeoutMs and the runtime flow is cancelled', async () => {
    const transport = load({ signInTimeoutMs: 20 });
    await transport.startSignIn();
    const error = await rejection(transport.waitForSignIn());
    expect(error.code).toBe('AI_KEY_REQUIRED');
    expect(reasonOf(error)).toBe('sign_in_expired');
    expect(sessions[0].login.cancel).toHaveBeenCalled();
  });

  it('a runtime message that says the code expired is an expired sign-in', async () => {
    const transport = load();
    await transport.startSignIn();
    const waiting = rejection(transport.waitForSignIn());
    await tick();
    pending[0].reject(new Error('the authorization expired'));
    expect(reasonOf(await waiting)).toBe('sign_in_expired');
  });

  it('waitForSignIn without a flow is a typed error', async () => {
    expect(reasonOf(await rejection(load().waitForSignIn()))).toBe('sign_in_not_started');
  });

  it('never agrees to keep the token in plaintext, and says why', async () => {
    const transport = load();
    await transport.startSignIn();
    const waiting = rejection(transport.waitForSignIn());
    await tick();
    pending[0].resolve({ kind: 'completed', result: { status: 'needs-plaintext-consent' } });
    const error = await waiting;
    expect(error.code).toBe('AI_KEY_REQUIRED');
    expect(reasonOf(error)).toBe('sign_in_needs_plaintext_consent');
    expect(sessions[0].login.advance).toHaveBeenCalledTimes(1);
    expect(sessions[0].login.cancel).toHaveBeenCalled();
  });

  it('chooses the only account when the runtime asks, and refuses to choose among several', async () => {
    const one = load();
    await one.startSignIn();
    const waitOne = one.waitForSignIn();
    await tick();
    pending[0].resolve({ kind: 'completed', result: { status: 'needs-account-selection', accounts: [{ selectionId: 'sel-1', login: 'a' }] } });
    await tick();
    expect(sessions[0].login.advance).toHaveBeenLastCalledWith({ flowId: 'flow-1', input: 'sel-1' });
    pending[1].resolve({ kind: 'completed', result: { status: 'completed', login: 'a' } });
    await expect(waitOne).resolves.toMatchObject({ isAuthenticated: true });

    pending = [];
    const many = load();
    await many.startSignIn();
    const waitMany = rejection(many.waitForSignIn());
    await tick();
    pending[0].resolve({ kind: 'completed', result: { status: 'needs-account-selection', accounts: [{ selectionId: 'a' }, { selectionId: 'b' }] } });
    expect(reasonOf(await waitMany)).toBe('sign_in_needs_account_selection');
  });

  it('a second startSignIn cancels the flow in progress', async () => {
    const transport = load();
    await transport.startSignIn();
    await transport.startSignIn();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].login.cancel).toHaveBeenCalled();
    expect(client.deleteSession).toHaveBeenCalledWith('acct-1');
  });

  it('signOut logs the active account out on a zero-tool session and deletes it', async () => {
    const transport = load();
    await transport.signOut();
    expect(sessions[0].set).toHaveBeenCalledWith({ command: { kind: 'logout' } });
    expect(sessions[0].disconnect).toHaveBeenCalled();
    expect(client.deleteSession).toHaveBeenCalledWith('acct-1');
  });

  it('signOut repeats while the runtime still holds other accounts', async () => {
    const transport = load();
    client.createSession.mockImplementationOnce(async () => {
      const set = jest.fn().mockResolvedValueOnce({ moreUsers: true }).mockResolvedValueOnce({ moreUsers: true }).mockResolvedValue({ moreUsers: false });
      return { sessionId: 'acct-x', disconnect: jest.fn(), rpc: { accounts: { set, login: {} } } };
    });
    await transport.signOut();
    // Three logouts: the third answers "no more users".
    expect(client.deleteSession).toHaveBeenCalledWith('acct-x');
  });

  it('signOut errors are typed and the session is still deleted', async () => {
    const transport = load();
    client.createSession.mockImplementationOnce(async () => ({
      sessionId: 'acct-y',
      disconnect: jest.fn(),
      rpc: { accounts: { set: jest.fn().mockRejectedValue(new Error('Missing required account selection')), login: {} } },
    }));
    expect((await rejection(transport.signOut())).code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(client.deleteSession).toHaveBeenCalledWith('acct-y');
  });

  it('an SDK release without the account RPCs is a typed error', async () => {
    client.createSession.mockImplementationOnce(async () => ({ sessionId: 'old', disconnect: jest.fn(), rpc: { tools: {} } }));
    const error = await rejection(load().startSignIn());
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(error.message).toMatch(/no sign-in API/);
  });
});
