import {
  ManagedDeleteVeto,
  installManagedDeleteHook,
  managedAbortTarget,
  managedDeleteTarget,
  MANAGED_BY_MODULE,
} from './managed-delete.hook';

const ID = '550e8400-e29b-41d4-a716-446655440000';

interface FakeReply {
  statusCode: number;
  body: unknown;
  code: jest.Mock<FakeReply, [number]>;
  send: jest.Mock<FakeReply, [unknown]>;
}

function makeReply(): FakeReply {
  const reply: FakeReply = {
    statusCode: 0,
    body: undefined,
    code: jest.fn((status: number) => {
      reply.statusCode = status;
      return reply;
    }),
    send: jest.fn((body: unknown) => {
      reply.body = body;
      return reply;
    }),
  };
  return reply;
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: 'DELETE',
    url: `/api/storage/objects/${ID}`,
    headers: { authorization: 'Bearer token' },
    ...overrides,
  };
}

describe('managedDeleteTarget', () => {
  it('matches only DELETE <prefix>/storage/objects/<uuid>', () => {
    expect(managedDeleteTarget('DELETE', `/api/storage/objects/${ID}`)).toBe(ID);
    expect(managedDeleteTarget('DELETE', `/api/storage/objects/${ID}/`)).toBe(ID);
    expect(managedDeleteTarget('DELETE', `/api/storage/objects/${ID}?force=1`)).toBe(ID);
    expect(managedDeleteTarget('GET', `/api/storage/objects/${ID}`)).toBeNull();
    expect(managedDeleteTarget('DELETE', `/api/storage/objects/${ID}/upload/abort`)).toBeNull();
    expect(managedDeleteTarget('DELETE', '/api/storage/objects/not-a-uuid')).toBeNull();
    expect(managedDeleteTarget('DELETE', `/storage/objects/${ID}`)).toBeNull();
    expect(managedDeleteTarget('DELETE', `/api/kvox/files/${ID}`)).toBeNull();
  });

  it('honours a different global prefix', () => {
    expect(managedDeleteTarget('DELETE', `/v1/storage/objects/${ID}`, 'v1')).toBe(ID);
    expect(managedDeleteTarget('DELETE', `/storage/objects/${ID}`, '')).toBe(ID);
  });
});

describe('managedAbortTarget', () => {
  it('matches only DELETE <prefix>/storage/objects/<uuid>/upload/abort', () => {
    expect(managedAbortTarget('DELETE', `/api/storage/objects/${ID}/upload/abort`)).toBe(ID);
    expect(managedAbortTarget('DELETE', `/api/storage/objects/${ID}/upload/abort/?x=1`)).toBe(ID);
    expect(managedAbortTarget('POST', `/api/storage/objects/${ID}/upload/abort`)).toBeNull();
    expect(managedAbortTarget('DELETE', `/api/storage/objects/${ID}/upload/abort-managed`)).toBeNull();
    expect(managedAbortTarget('DELETE', `/api/storage/objects/${ID}`)).toBeNull();
  });
});

describe('ManagedDeleteVeto', () => {
  let managedBy: jest.Mock;
  let veto: ManagedDeleteVeto;

  beforeEach(() => {
    managedBy = jest.fn().mockResolvedValue(new Map());
    veto = new ManagedDeleteVeto({} as never, { managedBy } as never);
  });

  it('answers 409 managed_by_module, in the platform error envelope, for a managed object', async () => {
    managedBy.mockResolvedValue(new Map([[ID, 'transcripts']]));
    const reply = makeReply();

    const result = await veto.hook()(makeRequest() as never, reply as never);

    expect(result).toBe(reply);
    expect(reply.statusCode).toBe(409);
    expect(reply.body).toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      path: `/api/storage/objects/${ID}`,
      details: { reason: MANAGED_BY_MODULE, module: 'transcripts' },
    });
    expect(typeof (reply.body as { message: string }).message).toBe('string');
    expect(managedBy).toHaveBeenCalledWith(expect.anything(), [ID]);
  });

  it('lets a plain upload through (no reply sent)', async () => {
    const reply = makeReply();
    await expect(veto.hook()(makeRequest() as never, reply as never)).resolves.toBeUndefined();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('ignores requests that are not an object delete, without reading the database', async () => {
    const reply = makeReply();
    await veto.hook()(makeRequest({ method: 'GET' }) as never, reply as never);
    await veto.hook()(makeRequest({ url: '/api/transcripts/1' }) as never, reply as never);
    expect(managedBy).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('passes an anonymous caller on so the platform guard answers 401', async () => {
    managedBy.mockResolvedValue(new Map([[ID, 'notes']]));
    const reply = makeReply();

    await veto.hook()(makeRequest({ headers: {} }) as never, reply as never);

    expect(managedBy).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('treats a cookie as credentials', async () => {
    managedBy.mockResolvedValue(new Map([[ID, 'graph']]));
    const reply = makeReply();
    await veto.hook()(makeRequest({ headers: { cookie: 'a=b' } }) as never, reply as never);
    expect(reply.statusCode).toBe(409);
  });

  it('fails closed with 503 when the ownership read fails', async () => {
    managedBy.mockRejectedValue(new Error('connection refused'));
    const reply = makeReply();

    await veto.hook()(makeRequest() as never, reply as never);

    expect(reply.statusCode).toBe(503);
    expect(JSON.stringify(reply.body)).not.toContain('connection refused');
  });
});

describe('ManagedDeleteVeto: upload abort', () => {
  const ABORT_URL = `/api/storage/objects/${ID}/upload/abort`;
  let managedBy: jest.Mock;
  let inject: jest.Mock;
  let veto: ManagedDeleteVeto;

  function abortRequest(overrides: Record<string, unknown> = {}) {
    return makeRequest({ url: ABORT_URL, server: { inject }, headers: { authorization: 'Bearer t', host: 'x', 'x-ignored': 'y' }, ...overrides });
  }

  beforeEach(() => {
    managedBy = jest.fn().mockResolvedValue(new Map([[ID, 'transcripts']]));
    inject = jest.fn().mockResolvedValue({ statusCode: 204, headers: {}, rawPayload: Buffer.alloc(0) });
    veto = new ManagedDeleteVeto({} as never, { managedBy } as never);
  });

  it('forwards a managed abort to the KVox route with the caller\'s credentials and relays the answer', async () => {
    const reply = makeReply();
    const reply204 = await veto.hook()(abortRequest() as never, reply as never);

    expect(reply204).toBe(reply);
    expect(inject).toHaveBeenCalledWith({
      method: 'DELETE',
      url: `/api/storage/objects/${ID}/upload/abort-managed`,
      headers: { authorization: 'Bearer t' },
    });
    expect(reply.statusCode).toBe(204);
    expect(reply.send).toHaveBeenCalledWith(undefined);
  });

  it('relays an error answer (status, content type and body) from the KVox route', async () => {
    const payload = Buffer.from('{"code":"NOT_FOUND"}');
    inject.mockResolvedValue({ statusCode: 404, headers: { 'content-type': 'application/json' }, rawPayload: payload });
    const reply: { statusCode: number; header: jest.Mock; code: jest.Mock; send: jest.Mock } = {
      statusCode: 0,
      header: jest.fn(),
      code: jest.fn(),
      send: jest.fn(),
    };
    reply.code.mockImplementation((status: number) => {
      reply.statusCode = status;
      return reply;
    });
    reply.send.mockImplementation(() => reply);

    await veto.hook()(abortRequest() as never, reply as never);

    expect(reply.statusCode).toBe(404);
    expect(reply.header).toHaveBeenCalledWith('content-type', 'application/json');
    expect(reply.send).toHaveBeenCalledWith(payload);
  });

  it('lets an unmanaged abort reach the platform handler', async () => {
    managedBy.mockResolvedValue(new Map());
    const reply = makeReply();

    await expect(veto.hook()(abortRequest() as never, reply as never)).resolves.toBeUndefined();

    expect(inject).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('passes an anonymous abort on so the platform guard answers 401', async () => {
    const reply = makeReply();
    await veto.hook()(abortRequest({ headers: {} }) as never, reply as never);
    expect(managedBy).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the lookup or the forward fails', async () => {
    managedBy.mockRejectedValueOnce(new Error('db down'));
    const lookupFailure = makeReply();
    await veto.hook()(abortRequest() as never, lookupFailure as never);
    expect(lookupFailure.statusCode).toBe(503);

    inject.mockRejectedValueOnce(new Error('boom'));
    const forwardFailure = makeReply();
    await veto.hook()(abortRequest() as never, forwardFailure as never);
    expect(forwardFailure.statusCode).toBe(503);
    expect(JSON.stringify(forwardFailure.body)).not.toContain('boom');
  });
});

describe('installManagedDeleteHook', () => {
  it('adds one onRequest hook to the Fastify instance', async () => {
    const addHook = jest.fn();
    const managedBy = jest.fn().mockResolvedValue(new Map([[ID, 'transcripts']]));
    const veto = new ManagedDeleteVeto({} as never, { managedBy } as never);
    const app = {
      get: jest.fn().mockReturnValue(veto),
      getHttpAdapter: () => ({ getInstance: () => ({ addHook }) }),
    };

    installManagedDeleteHook(app as never);

    expect(app.get).toHaveBeenCalledWith(ManagedDeleteVeto, { strict: false });
    expect(addHook).toHaveBeenCalledTimes(1);
    expect(addHook.mock.calls[0][0]).toBe('onRequest');

    const reply = makeReply();
    await addHook.mock.calls[0][1](makeRequest(), reply);
    expect(reply.statusCode).toBe(409);
  });
});
