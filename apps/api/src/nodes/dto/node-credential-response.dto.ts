import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The response to `POST /api/node-credentials` — THE ONLY PLACE `token` EVER
 * APPEARS.
 *
 * There is deliberately no second DTO carrying `token`, and
 * {@link NodeCredentialListItemDto} below does not have the field at all
 * rather than having it typed `string | null`. That is the point: an
 * accidental "just include the token in the list too" cannot be written
 * without adding a property to a class whose absence is documented here, so
 * the show-once contract is enforced by the type rather than by everyone
 * remembering it. The row itself only ever stores a sha256 hash, so even a
 * mistake at this layer could not surface the real value — but a DTO that
 * cannot express it is the cheaper of the two guarantees.
 */
export class NodeCredentialCreatedResponseDto {
  @ApiProperty({
    description:
      'The raw `nod_…` token. Shown EXACTLY ONCE, in this response only — the ' +
      'server stores a hash and can never display it again. Store it in the ' +
      "node's configuration now; a lost token is replaced by revoking this " +
      'credential and creating another.',
  })
  token!: string;

  @ApiProperty({ description: 'Credential ID (UUID)' })
  id!: string;

  @ApiProperty({ description: 'Operator-chosen label for this credential' })
  name!: string;

  @ApiProperty({
    description: 'Non-secret display prefix (e.g. `nod_1a2b`) for telling credentials apart',
  })
  tokenPrefix!: string;

  @ApiPropertyOptional({
    description:
      'ISO 8601 expiry timestamp, or `null` when this credential never expires ' +
      '(the default). `null` is a supported, expected value here — a worker node ' +
      'runs unattended, and revocation rather than a clock is the intended control.',
    nullable: true,
  })
  expiresAt!: string | null;

  @ApiProperty({ description: 'ISO 8601 creation timestamp' })
  createdAt!: string;
}

/**
 * One credential as it appears in `GET /api/node-credentials`.
 *
 * Note what is NOT here: `token` (see above) and `tokenHash`. The hash is
 * omitted not because it is directly usable — it is not, a node authenticates
 * with the preimage — but because publishing it hands an attacker an offline
 * verification oracle: a stolen list would let them confirm a guessed token
 * without ever touching this API, invisibly to any rate limit or audit trail
 * here. The service's `select` is the enforcement point; this DTO is the
 * documentation of it.
 */
export class NodeCredentialListItemDto {
  @ApiProperty({ description: 'Credential ID (UUID)' })
  id!: string;

  @ApiProperty({ description: 'Operator-chosen label for this credential' })
  name!: string;

  @ApiProperty({ description: 'Non-secret display prefix (e.g. `nod_1a2b`)' })
  tokenPrefix!: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 expiry timestamp, or `null` when this credential never expires',
    nullable: true,
  })
  expiresAt!: string | null;

  @ApiPropertyOptional({
    description:
      'ISO 8601 timestamp of the last successful authentication, or `null` if never ' +
      'used. This is the operator-facing answer to "is this node still alive, or is ' +
      'this credential safe to revoke".',
    nullable: true,
  })
  lastUsedAt!: string | null;

  @ApiProperty({ description: 'ISO 8601 creation timestamp' })
  createdAt!: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 revocation timestamp, or `null` while the credential is active',
    nullable: true,
  })
  revokedAt!: string | null;
}
