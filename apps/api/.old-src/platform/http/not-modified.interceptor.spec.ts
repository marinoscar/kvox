import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { NotModifiedInterceptor } from './not-modified.interceptor';

function contextOf(type: string, statusCode?: number): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({ getResponse: () => ({ statusCode }) }),
  } as unknown as ExecutionContext;
}

const handlerOf = (body: unknown): CallHandler => ({ handle: () => of(body) });

describe('NotModifiedInterceptor', () => {
  const interceptor = new NotModifiedInterceptor();

  it('lets a 304 through with no body, so no envelope is serialised', async () => {
    const envelope = { data: undefined, meta: { timestamp: 'now' } };

    const result = await firstValueFrom(interceptor.intercept(contextOf('http', 304), handlerOf(envelope)));

    expect(result).toBeUndefined();
  });

  it('drops a body the inner chain produced for a 304', async () => {
    const result = await firstValueFrom(interceptor.intercept(contextOf('http', 304), handlerOf({ data: { id: 1 } })));

    expect(result).toBeUndefined();
  });

  it.each([200, 201, 204, 400, 404])('keeps the body of a %i response unchanged', async (status) => {
    const envelope = { data: { id: 1 }, meta: { timestamp: 'now' } };

    const result = await firstValueFrom(interceptor.intercept(contextOf('http', status), handlerOf(envelope)));

    expect(result).toBe(envelope);
  });

  it('keeps the body when the response has no status yet', async () => {
    const envelope = { data: 1 };

    const result = await firstValueFrom(interceptor.intercept(contextOf('http'), handlerOf(envelope)));

    expect(result).toBe(envelope);
  });

  it('passes a non-HTTP context straight to the handler without touching the response', async () => {
    const getResponse = jest.fn();
    const context = { getType: () => 'rpc', switchToHttp: () => ({ getResponse }) } as unknown as ExecutionContext;
    const body = { data: 1 };

    const result = await firstValueFrom(interceptor.intercept(context, handlerOf(body)));

    expect(result).toBe(body);
    expect(getResponse).not.toHaveBeenCalled();
  });
});
