import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The error body this API returns for every endpoint but one.
 *
 * `HttpExceptionFilter` rebuilds error responses from a fixed key allowlist —
 * `statusCode`, `code`, `message`, `details`, `timestamp`, `path` and nothing
 * else — so this class is not an approximation of the wire format, it is the
 * complete set of keys that can appear. In particular a custom top-level field
 * on a thrown `HttpException` payload is silently dropped; endpoint-specific
 * data belongs under {@link details}.
 *
 * THE ONE EXCEPTION (#153): an endpoint whose error body is fixed by an
 * external standard can opt out of this envelope entirely, by branding its
 * exception with `withVerbatimErrorBody`
 * (`common/exceptions/verbatim-error-body.exception.ts`). Its body is then sent
 * exactly as thrown, with none of the keys below. Today the only user is
 * `POST /auth/device/token`, which RFC 8628 §3.5 requires to answer with
 * `{ error, error_description }` — see `DeviceTokenErrorDto`, which the
 * operation declares for its 400 and 401 responses. That opt-out is deliberately
 * hard to reach and rare; assume this envelope unless an operation documents
 * otherwise.
 *
 * Kept as an `@ApiProperty` class rather than a zod DTO because nothing
 * validates it — it is documentation-only, produced by the filter and never
 * parsed on the way in.
 */
export class ErrorDto {
  @ApiProperty({
    description: 'HTTP status code, repeated in the body so a logged payload is self-describing.',
    example: 409,
  })
  statusCode!: number;

  @ApiProperty({
    description:
      'Stable machine-readable code. Derived from the status by the exception filter, which ' +
      'overwrites any `code` a thrown exception supplied — so it is always one of the values ' +
      'below. Prefer branching on this over matching `message`, which is prose and may change.',
    example: 'CONFLICT',
    // Mirrors `HttpExceptionFilter.getCodeFromStatus` exactly: the eight mapped
    // statuses, plus the `ERROR` fallback an unmapped status produces.
    enum: [
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'UNPROCESSABLE_ENTITY',
      'TOO_MANY_REQUESTS',
      'INTERNAL_ERROR',
      'ERROR',
    ],
  })
  code!: string;

  @ApiProperty({
    description: 'Human-readable description of what went wrong.',
    example: 'Email already in allowlist',
  })
  message!: string;

  @ApiPropertyOptional({
    description:
      'Endpoint-specific structured data — the only place a custom field survives the exception ' +
      'filter. Omitted when the failure carried none. Shape varies by endpoint and is documented ' +
      'on the operation that returns it.',
    example: { field: 'email' },
  })
  details?: unknown;

  @ApiProperty({
    description: 'When the error was produced, ISO 8601 UTC.',
    example: '2026-08-17T04:37:58.000Z',
  })
  timestamp!: string;

  @ApiProperty({
    description: 'Request path that produced the error.',
    example: '/api/allowlist',
  })
  path!: string;
}
