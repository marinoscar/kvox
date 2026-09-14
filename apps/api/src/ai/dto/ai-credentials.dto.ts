import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  MAX_AI_API_KEY_LENGTH,
  MAX_AI_CREDENTIAL_LABEL_LENGTH,
} from '../ai-credential.constants';

// =============================================================================
// Per-user AI credentials — request and response bodies (issue #47, epic #45)
// =============================================================================
//
// `apiKey` IS THE ONLY SECRET-BEARING FIELD IN THIS FILE, IT EXISTS ON THE
// REQUEST AND ON NOTHING ELSE, AND ITS ENTIRE LIFETIME IS:
//
//     request body → controller → UserAiCredentialsService.save
//       → encryptSecret(…, 'ai-key') → user_ai_credentials.secret
//
// There is no branch on which it travels back out. Every response schema below
// carries its own proof by construction: there is no field able to hold it, the
// presentation query does not even select the ciphertext column, and the
// integration test asserts the absence against the SERIALIZED body rather than
// against a DTO — because a DTO that happened to gain a field would still pass
// a test that only inspected the DTO's declared shape.
//
// -----------------------------------------------------------------------------
// BLANK PRESERVES — DO NOT "NORMALISE" THE KEY
// -----------------------------------------------------------------------------
//
// The form renders the key box EMPTY, because the stored value is unreadable by
// design. An empty submission therefore means "keep what is stored" and can
// never mean "erase it" — erasing is `DELETE /api/ai-credentials/{provider}`.
//
// That contract is easy to defeat from here and every way of doing it looks
// like tidying up: `.trim()` turns a key whose surrounding whitespace matters
// into a different key; `.min(1)` turns a label-only edit into a 400 for a user
// who cannot see the value they would have to retype; `.default('')` turns
// "absent" into a value. So: `z.string()` with a ceiling and nothing else, and
// `.nullish()` because a JSON body deserialises an omitted field to `undefined`
// and a cleared one to `null` and the user means the same thing by both.
// =============================================================================

/** `PUT /api/ai-credentials` — save or replace the CALLER'S OWN key. */
export const saveAiCredentialSchema = z.object({
  provider: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe(
      'Which registered AI provider this key is for, e.g. `openai`. An unknown id is a 400 naming the valid ones.',
    ),
  /**
   * The key.
   *
   * WRITE-ONLY. Blank, `null` or absent all mean "keep the stored key" — see
   * the header. There is no way to erase a key through this endpoint.
   */
  apiKey: z
    .string()
    .max(MAX_AI_API_KEY_LENGTH)
    .nullish()
    .describe(
      'Your provider API key. **Write-only** — it is encrypted at rest and is never returned by this or any other endpoint. Blank or absent keeps the stored key (use DELETE to erase one).',
    ),
  label: z
    .string()
    .trim()
    .max(MAX_AI_CREDENTIAL_LABEL_LENGTH)
    .nullish()
    .describe(
      'An optional, non-secret note to tell two keys apart ("work", "personal"). `null` clears it; absent leaves it unchanged.',
    ),
});

export class SaveAiCredentialDto extends createZodDto(saveAiCredentialSchema) {}

/**
 * `POST /api/ai-credentials/test` — the probe body.
 *
 * `apiKey` IS OPTIONAL AND THAT IS THE POINT: a user must be able to prove a
 * key BEFORE saving it, which is the one workflow that turns a mistyped key
 * into a ten-second problem instead of a failed generation twenty minutes
 * later. Absent falls back to the stored key, which is how "is the key I saved
 * last month still valid?" is asked.
 */
export const testAiCredentialSchema = z.object({
  provider: z.string().trim().min(1).max(64).describe('Which provider to probe.'),
  apiKey: z
    .string()
    .max(MAX_AI_API_KEY_LENGTH)
    .nullish()
    .describe(
      'The key to probe with. **It does not need to have been saved.** Absent falls back to your stored key.',
    ),
});

export class TestAiCredentialDto extends createZodDto(testAiCredentialSchema) {}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

/**
 * The masked view of one stored key.
 *
 * ⚠ EVERY FIELD IS NON-SECRET BY CONSTRUCTION. `hint` is the same mask
 * `Credential.hint` carries (`••••` plus at most four trailing characters, and
 * nothing at all below eight), derived on write by code that already held the
 * plaintext. Nothing here can widen it, and no other part of the secret is
 * representable in this shape.
 */
export const aiCredentialStatusSchema = z.object({
  provider: z.string().describe('Which provider this key is for.'),
  configured: z
    .boolean()
    .describe('Whether a key is stored for this provider. Always true in a listing.'),
  hint: z
    .string()
    .nullable()
    .describe(
      'A masked hint such as `••••a1b2`, or null when nothing is stored. NEVER the key itself.',
    ),
  label: z
    .string()
    .nullable()
    .describe('Your own non-secret note for this key.'),
  lastUsedAt: z
    .iso
    .datetime()
    .nullable()
    .describe(
      'When this key was last used for a generation or a successful probe. Informational only — nothing in this application acts on it.',
    ),
  updatedAt: z
    .iso
    .datetime()
    .nullable()
    .describe('When the stored key was last written.'),
});

export class AiCredentialStatusDto extends createZodDto(
  aiCredentialStatusSchema,
) {}

/** `GET /api/ai-credentials` — every key the caller has stored, masked. */
export const aiCredentialListSchema = z.object({
  credentials: z
    .array(aiCredentialStatusSchema)
    .describe(
      'Your own stored keys, one per provider. **Never contains a secret** — only the provider, a mask, your label and timestamps.',
    ),
});

export class AiCredentialListDto extends createZodDto(aiCredentialListSchema) {}

/** `POST /api/ai-credentials/test` — the outcome of the probe. */
export const aiConnectionTestSchema = z.object({
  ok: z.boolean().describe('Whether the provider accepted the key.'),
  latencyMs: z.number().describe('Wall-clock milliseconds the probe took.'),
  detail: z
    .string()
    .describe(
      'A specific, actionable sentence — which of "the key is wrong", "the account is out of credit" and "the endpoint is unreachable" happened. Only the last of those is anybody else\'s problem.',
    ),
});

export class AiConnectionTestDto extends createZodDto(aiConnectionTestSchema) {}
