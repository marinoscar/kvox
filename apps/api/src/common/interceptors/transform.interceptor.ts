import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  data: T;
  meta?: {
    timestamp: string;
    [key: string]: unknown;
  };
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    // -------------------------------------------------------------------------
    // SSE HANDLERS ARE NOT ENVELOPED (issue #127, epic #109)
    // -------------------------------------------------------------------------
    //
    // An `@Sse()` handler returns an Observable of `MessageEvent`s, and this
    // interceptor sits between it and the framework's `SseStream` — so without
    // this guard the map below runs once PER EVENT, not once per response.
    //
    // The damage is not hypothetical and it is not cosmetic. A heartbeat is a
    // COMMENT-ONLY message, `{ comment: 'heartbeat' }`, which has no `data`
    // key — so the passthrough test below misses it and it gets wrapped into
    // `{ data: { comment: 'heartbeat' }, meta: … }`. `SseStream` then writes
    // that as a real `data:` frame, and every client's `onmessage` fires for
    // what was supposed to be an invisible keep-alive. The heartbeat stops
    // being a heartbeat and becomes a notification-shaped object arriving
    // every 25 seconds.
    //
    // Data-carrying frames survive by luck rather than design (a `MessageEvent`
    // happens to have a `data` key, so the passthrough returns it untouched),
    // and relying on that coincidence for a security-relevant transport is not
    // acceptable. The envelope is a REQUEST/RESPONSE convention — one body,
    // one `meta.timestamp` — and an SSE stream is neither.
    //
    // Keyed on Nest's OWN `@Sse()` metadata rather than a route allowlist, so
    // any SSE endpoint added later is correct without anybody remembering this
    // file exists.
    const isSse = Reflect.getMetadata(SSE_METADATA, context.getHandler());
    if (isSse) {
      return next.handle() as Observable<ApiResponse<T>>;
    }

    return next.handle().pipe(
      map((data) => {
        // If already wrapped, return as-is
        if (data && typeof data === 'object' && 'data' in data) {
          return data;
        }

        return {
          data,
          meta: {
            timestamp: new Date().toISOString(),
          },
        };
      }),
    );
  }
}
