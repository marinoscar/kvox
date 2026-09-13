import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for successful device authorization.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE DTO WITH OPTIONAL FIELDS RATHER THAN TWO RESPONSE SHAPES (#141)
 * ---------------------------------------------------------------------------
 * RFC 8628 §3.5 says the token response IS an OAuth 2.0 token response:
 * `access_token` + `token_type` required, `refresh_token` and `expires_in`
 * optional. Both credentials this flow can mint fit that contract; they differ
 * only in which optional parts they carry. So this stays ONE shape.
 *
 * The governing constraint is that the SESSION path's response must be
 * byte-for-byte what it has always been (epic #110, success criterion 9). It
 * is: no field it emitted was removed, renamed, or re-typed on the wire, and
 * no field was ADDED to it either. Everything new below is populated only on
 * the `pat` branch. `refreshToken` became optional in TypeScript and in
 * OpenAPI, but the session branch still populates it, so no existing client
 * sees a change.
 *
 * `tokenType` stays the literal `'Bearer'` for BOTH paths. This is deliberate
 * and is the one field it would be tempting to overload: a PAT *is* presented
 * as `Authorization: Bearer pat_...`, and `JwtAuthGuard` accepts it on exactly
 * that header (it branches on the `pat_` prefix before delegating to the JWT
 * strategy). Returning `tokenType: 'PAT'` would tell a spec-compliant OAuth
 * client that it does NOT hold a bearer credential, and it would stop sending
 * the only header that works. `token_type` describes HOW to present a
 * credential, never what kind of record backs it.
 *
 * HOW A CLIENT TELLS THE TWO APART: `credentialType`. It is present and equal
 * to `'pat'` on the PAT branch and ABSENT on the session branch — the exact
 * mirror of the request side, where `clientInfo.tokenType` absent likewise
 * means session. One rule, stated once, holding in both directions: no tag
 * means the legacy session credential. Discriminating instead on
 * `refreshToken === undefined` would happen to work today but is an accidental
 * signal — a client cannot distinguish "this kind has no refresh token" from
 * "the server failed to send one", and it would mis-handle any future
 * credential kind. An explicit tag is checkable and greppable.
 * ---------------------------------------------------------------------------
 */
export class DeviceTokenResponseDto {
  @ApiProperty({
    description:
      'The credential to present as `Authorization: Bearer <token>`. A signed ' +
      'JWT for a session credential; an opaque `pat_...` token when ' +
      '`credentialType` is `pat`.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken!: string;

  @ApiProperty({
    description:
      'Refresh token for obtaining new access tokens. Present for the session ' +
      'credential only. A personal access token has no refresh token by design: ' +
      're-running the device login is its renewal path, and this API\'s refresh ' +
      'flow relies on an HttpOnly cookie that a CLI does not have.',
    example: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
    required: false,
  })
  refreshToken?: string;

  @ApiProperty({
    description:
      'OAuth 2.0 token type — always `Bearer`, for both credential kinds. It ' +
      'describes how to present the token, not which kind it is; branch on ' +
      '`credentialType` for that.',
    example: 'Bearer',
  })
  tokenType!: string;

  @ApiProperty({
    description:
      'Token lifetime in seconds. For the session credential this is ' +
      '`DEVICE_TOKEN_EXPIRY_DAYS` (7 days = 604800 seconds by default), not the ordinary ' +
      '15-minute web access-token TTL. For a PAT it is the remaining time until `expiresAt` ' +
      '(`DEVICE_PAT_EXPIRY_DAYS`, 90 days by default); prefer the absolute `expiresAt` there.',
    example: 604800,
  })
  expiresIn!: number;

  @ApiProperty({
    description:
      'Set to `pat` when the device requested `clientInfo.tokenType: "pat"` and ' +
      'a personal access token was issued. ABSENT for the default session ' +
      'credential, mirroring the request side where an absent ' +
      '`clientInfo.tokenType` means session. Clients should branch on this.',
    enum: ['pat'],
    example: 'pat',
    required: false,
  })
  credentialType?: 'pat';

  @ApiProperty({
    description:
      'Absolute expiry, ISO-8601. PAT only. A CLI persists its token to a config ' +
      'file and re-reads it days later, where a relative `expiresIn` captured at ' +
      'issue time is useless without also storing the issue instant; an absolute ' +
      'timestamp survives that round trip on its own.',
    example: '2026-11-28T12:00:00.000Z',
    required: false,
  })
  expiresAt?: string;

  @ApiProperty({
    description:
      'Identifier of the issued personal access token. PAT only. Lets a client ' +
      'name the exact row to revoke in the Access Tokens page ' +
      '(`DELETE /api/pat/{id}`). Not a secret — it is already returned by `GET /api/pat`.',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  tokenId?: string;

  @ApiProperty({
    description:
      'Display name given to the issued personal access token, so a client can ' +
      'tell the user which row to look for in the Access Tokens list. PAT only.',
    example: 'Device: oscar-laptop',
    required: false,
  })
  tokenName?: string;
}
