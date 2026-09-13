import {
  BadRequestException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { withVerbatimErrorBody } from '../../common/exceptions/verbatim-error-body.exception';

/**
 * The error codes `POST /auth/device/token` can return.
 *
 * A closed union, not `string`, so a typo is a compile error rather than an
 * error code no client has ever heard of. RFC 8628 §3.5 defines the first four;
 * `invalid_grant` and `invalid_request` come from RFC 6749 §5.2, which §3.5
 * defers to for everything else.
 */
export type DeviceTokenErrorCode =
  // The user has not acted yet. The client keeps polling at its interval.
  | 'authorization_pending'
  // The client is polling too fast and must increase its interval by 5s.
  | 'slow_down'
  // The device code is past its lifetime. The client must restart the flow.
  | 'expired_token'
  // The user pressed Deny. The client must stop and say so — retrying is wrong.
  | 'access_denied'
  // The device code is unknown, already redeemed, or otherwise unusable.
  | 'invalid_grant'
  // Nothing else fits.
  | 'invalid_request';

/**
 * HTTP status per error code.
 *
 * `invalid_grant` maps to 401 because that is what this endpoint has ALWAYS
 * returned, and #153 is about the response BODY, not its status line. Note for
 * whoever revisits this: RFC 6749 §5.2 actually specifies 400 for every code
 * here except `invalid_client`, so the 401 is a deviation. It is left alone
 * deliberately — changing a status is a separate, independently testable
 * behaviour change, and a device client keys off the `error` value (which is
 * now correct) rather than off the status. Fix it in its own issue if it ever
 * matters, not as a side effect of this one.
 */
const STATUS_BY_CODE: Record<DeviceTokenErrorCode, 400 | 401> = {
  authorization_pending: 400,
  slow_down: 400,
  expired_token: 400,
  access_denied: 400,
  invalid_grant: 401,
  invalid_request: 400,
};

/**
 * Build the RFC 8628 error for the device token endpoint.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY TOKEN-ENDPOINT ERROR GOES THROUGH THIS ONE FUNCTION (#153)
 * ---------------------------------------------------------------------------
 * Because the alternative is what the bug already was. The service used to
 * throw `new BadRequestException({ error: 'authorization_pending', … })`
 * directly — a shape that looks obviously correct at the throw site and was
 * silently flattened by the global exception filter into a generic
 * `{ statusCode: 400, code: 'BAD_REQUEST', message: 'An unexpected error
 * occurred' }`. All four RFC outcomes came out byte-identical, so a client
 * could not tell "still waiting" from "the user said no", and the failure was
 * invisible to unit tests (which assert the thrown exception, before the filter
 * runs) and to integration tests (which never polled).
 *
 * Routing every one of them through this function means the opt-out brand is
 * applied in one place instead of at nine throw sites, so a NEW outcome added
 * later cannot forget it: writing `throw deviceTokenError('…')` is the only way
 * to name a code, and the union type refuses anything that is not a real one.
 * That is the property worth having — a future contributor who has never read
 * #153 gets a compliant response by copying the line next to theirs.
 *
 * The returned instance is still a `BadRequestException` /
 * `UnauthorizedException`, so callers and tests that branch on the exception
 * type are unaffected; the only added fact is "send this body verbatim".
 */
export function deviceTokenError(
  error: DeviceTokenErrorCode,
  errorDescription: string,
): HttpException {
  // Snake_case on the wire, per the RFC. This object is what the client
  // receives — the filter sends it untouched, adding nothing.
  const body = { error, error_description: errorDescription };

  const exception =
    STATUS_BY_CODE[error] === 401
      ? new UnauthorizedException(body)
      : new BadRequestException(body);

  return withVerbatimErrorBody(exception);
}
