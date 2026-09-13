import { ApiProperty } from '@nestjs/swagger';

/**
 * Error response for `POST /auth/device/token`, per RFC 8628 §3.5.
 *
 * This is NOT the shared `ErrorDto` envelope, and that is deliberate: the RFC
 * fixes the token endpoint's error body, and `error` is the whole protocol —
 * a client polls on `authorization_pending`, backs off on `slow_down`,
 * restarts on `expired_token`, and stops on `access_denied`. `DeviceAuthService`
 * throws these through `deviceTokenError()`, which brands the exception so
 * `HttpExceptionFilter` sends this body verbatim rather than flattening it into
 * the envelope, which used to make all four outcomes byte-identical (#153).
 */
export class DeviceTokenErrorDto {
  @ApiProperty({
    description:
      'RFC 8628 §3.5 / RFC 6749 §5.2 error code. Branch on this, never on the ' +
      'description or the HTTP status.',
    enum: [
      'authorization_pending',
      'slow_down',
      'expired_token',
      'access_denied',
      'invalid_grant',
      'invalid_request',
    ],
    example: 'authorization_pending',
  })
  error!: string;

  @ApiProperty({
    description: 'Human-readable error description. Prose; may change.',
    example: 'User has not yet authorized this device',
  })
  error_description!: string;
}
