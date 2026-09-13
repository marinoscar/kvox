// =============================================================================
// CredentialInfo — the presentation-safe view of a stored credential
// (issue #115, epic #108)
// =============================================================================
//
// This file exists to make "no plaintext egress" a property of the TYPE SYSTEM
// rather than a property of everyone's good intentions.
//
// The store has two reads with two different return types:
//
//   CredentialsService.getSecret()  -> string | null   (plaintext, server-side)
//   CredentialsService.describe()   -> CredentialInfo  (safe for a response)
//
// Everything that can reach an HTTP response, an OpenAPI schema, or a log line
// travels as `CredentialInfo`. `CredentialInfo` has no field capable of holding
// secret material — not the plaintext and not the ciphertext — so the change
// that leaks a secret ("just add it to the DTO") does not have a place to land.
// Someone determined can still call `getSecret` and paste the result into a
// response, but that is a visible, reviewable act rather than a one-word edit
// to a type nobody reads.
//
// There is deliberately NO `{ includeSecret?: boolean }` option on the reads.
// A boolean parameter that decides whether a response leaks a secret is exactly
// the call site that gets flipped under time pressure, and it is invisible in a
// diff of the caller. Two methods, two types, no flag.
// =============================================================================

/**
 * Everything about a credential that is safe to serialise: who it is, what it
 * is for, roughly what is in it, and who touched it last.
 *
 * WHAT IS ABSENT AND WHY:
 *
 * - `secret` / any plaintext. The whole point; see the header.
 * - The ciphertext. Not merely "not useful" — an attacker holding a base64
 *   payload has the thing that a leaked/rotated key turns into a password, and
 *   it also survives being copied somewhere the encryption key can read it.
 *   Presentation never needs it.
 * - `id`. The store's address is `(purpose, name)`, and that is the ONLY way
 *   to reach a credential. Publishing a uuid invites an id-addressed lookup,
 *   and an id-addressed lookup silently drops the `purpose` scoping that both
 *   the table's uniqueness and the cipher's sub-key domain are built on.
 */
export interface CredentialInfo {
  /** Sub-key domain from #114 and the first half of the address: 'smtp', … */
  readonly purpose: string;

  /** Discriminator within a purpose: 'default', a provider id, … */
  readonly name: string;

  /**
   * Non-secret display aid, derived from the plaintext on write — never
   * supplied by a caller. Null only for a row written outside this service.
   */
  readonly hint: string | null;

  /** Human description for the admin UI. Admin-entered, non-secret. */
  readonly label: string | null;

  /** Provenance: who last set the value. Null if the user was deleted. */
  readonly updatedByUserId: string | null;

  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Metadata accepted alongside a write.
 *
 * Note what is NOT here: `hint`. A caller computing the hint is a caller
 * holding the plaintext longer than it needs to, and a caller free to get it
 * wrong (send the whole password as the "hint" and the mask is decorative).
 * The service derives it from the plaintext it already has, in one place.
 *
 * Both fields are optional and distinguish "not provided" from "explicitly
 * null": omitting `label` on a write leaves the stored label alone, whereas
 * passing `null` clears it. Metadata is not secret, so clearing it is a
 * legitimate thing to ask for — unlike the secret, where blank means preserve.
 */
export interface CredentialMeta {
  readonly label?: string | null;
  readonly updatedByUserId?: string | null;
}

// -----------------------------------------------------------------------------
// Compile-time proofs. These are types only — they emit nothing — but a
// violation is a build failure, which is the point: the guarantee above is
// worth exactly as much as the thing that fails when someone breaks it.
// -----------------------------------------------------------------------------

/** Fails to compile unless `T` is exactly `true`. */
type AssertTrue<_T extends true> = void;

/**
 * Field names that would, or plausibly could, carry secret material. Checked
 * as a set rather than just `'secret'` because the leak arrives under whatever
 * name the person adding it happened to pick.
 */
type SecretBearingKey =
  | 'secret'
  | 'secretValue'
  | 'plaintext'
  | 'password'
  | 'value'
  | 'ciphertext'
  | 'encrypted'
  | 'payload';

/**
 * PROOF 1: `CredentialInfo` declares no secret-bearing field.
 *
 * If this line errors, do not widen the list — the field being added is the
 * bug. A consumer that needs the plaintext calls `getSecret` from server-side
 * code; nothing that needs it should be shaped like a response DTO.
 */
type _CredentialInfoCarriesNoSecret = AssertTrue<
  [Extract<keyof CredentialInfo, SecretBearingKey>] extends [never] ? true : false
>;

/**
 * PROOF 2: the same for the write-side metadata, which also stops `hint` from
 * quietly becoming a caller-supplied field again.
 */
type _CredentialMetaCarriesNoSecret = AssertTrue<
  [Extract<keyof CredentialMeta, SecretBearingKey | 'hint'>] extends [never]
    ? true
    : false
>;
