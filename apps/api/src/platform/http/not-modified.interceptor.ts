// =============================================================================
// A 304 carries no body and no envelope (issue #464, epic #462)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(#464): this app's own `TransformInterceptor` skipped the
// `{ data, meta }` envelope once the response status was 304 (`304` has no
// content, RFC 9110 section 15.4.5). The platform's `TransformInterceptor` does
// not: it answers a handler's `undefined` with `{ data: undefined, meta }`, which
// goes out as `Content-Type: application/json` and a `Content-Length` that no
// 200 would ever have had. The conditional reads (`GET /api/transcripts/:id` and
// its segments, `GET /api/notes/:id`, the ontology turtle routes) depend on the
// bare 304.
//
// This interceptor sits OUTSIDE the platform's (app-module interceptors register
// before the host core's, and the first registered is the outermost): whatever
// the inner chain produced, a 304 leaves with no payload. Delete it when the
// platform's `TransformInterceptor` skips the envelope for a 304.
// =============================================================================

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class NotModifiedInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    return next.handle().pipe(
      map((body) =>
        context.switchToHttp().getResponse<{ statusCode?: number }>()?.statusCode === 304
          ? undefined
          : body,
      ),
    );
  }
}
