import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The kind of credential a device is asking the flow to mint on approval.
 *
 * `'session'` is the historical behaviour and MUST stay the default (#141,
 * epic #110 success criterion 9). The web activation page sends no
 * `tokenType` at all, so anything other than a default here would silently
 * change what every existing browser-driven activation produces.
 *
 * `'pat'` is what a CLI asks for: a personal access token that outlives a
 * terminal session and — the property that makes a long-lived credential
 * acceptable at all — is revocable from the web UI's Access Tokens page
 * without rotating anything else.
 */
export const DeviceTokenTypeSchema = z.enum(['session', 'pat']);

export type DeviceTokenType = z.infer<typeof DeviceTokenTypeSchema>;

/**
 * Client info schema for device authorization requests.
 *
 * WARNING: every field here arrives from an UNAUTHENTICATED caller
 * (`POST /auth/device/code` is `@Public()`), is persisted verbatim into
 * `device_codes.client_info`, and is later rendered in two places a human
 * trusts — the activation page and, for `tokenType: 'pat'`, the Access Tokens
 * list. Treat it as hostile at every point of use; see
 * `DeviceAuthService.buildPatName()` for the sanitisation that guards the
 * token-name path.
 */
export const ClientInfoSchema = z.object({
  deviceName: z.string().optional(),
  userAgent: z.string().optional(),

  // `.default('session')` rather than `.optional()`: zod fills the value in, so
  // the service never has to re-derive the default and there is exactly one
  // place the fallback is written down. An unknown value (e.g. a typo'd
  // 'PAT', or a probe sending 'admin') is REJECTED with a 400 by the global
  // ZodValidationPipe rather than quietly falling back — a device that asked
  // for something we do not understand should not be handed a credential of
  // our choosing.
  tokenType: DeviceTokenTypeSchema.default('session'),
});

/**
 * Request DTO for initiating device authorization flow
 */
export const DeviceCodeRequestSchema = z.object({
  clientInfo: ClientInfoSchema.optional(),
});

export class DeviceCodeRequestDto extends createZodDto(DeviceCodeRequestSchema) {
  @ApiProperty({
    description:
      'Optional client information. `tokenType` selects the credential this flow will mint ' +
      'when the device polls `POST /auth/device/token` after the user approves (it is minted ' +
      'on the poll, not at approval): `session` (default) returns a short-lived JWT plus a ' +
      'refresh token, `pat` returns a long-lived, revocable personal access token for CLI ' +
      'use, tagged `credentialType: "pat"` in the poll response. An unrecognised `tokenType` ' +
      'is rejected with a 400. `deviceName` is echoed to the approving user on the activation ' +
      'page and, for `pat`, becomes the token name in the Access Tokens list.',
    required: false,
  })
  // Typed as the schema's OUTPUT rather than re-declared by hand: after
  // `.default('session')` zod guarantees `tokenType` is populated once parsed,
  // and a hand-written `tokenType?:` would contradict the generated base class.
  // Deriving it also means the two can never drift apart again.
  clientInfo?: z.infer<typeof ClientInfoSchema>;
}
