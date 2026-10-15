// =============================================================================
// The reusable branches of the Danger Zone summary (issue #80, split by #460)
// =============================================================================
//
// These were the top of `user-data.dto.ts`. They moved out so a domain's
// `*.user-data.ts` can build its category's response branch from them WITHOUT
// importing `user-data.dto.ts`, which COMPOSES the published summary schema from
// the category registry at import time and would therefore read an empty
// registry when a domain file is evaluated by `kvox.manifest.ts`. This file
// reads no registry.
//
// See `user-data.dto.ts` for why `bytes` is a decimal string.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** One category's row count and the bytes behind it. */
export const userDataCategorySchema = z.object({
  count: z
    .number()
    .int()
    .describe('How many rows of this category the caller owns, soft-deleted ones excluded.'),
  bytes: z
    .string()
    .describe(
      'Total size in bytes of the storage objects this category owns, as a **decimal ' +
        'string**. A string rather than a number because a large media library exceeds ' +
        "JavaScript's safe integer range and a JSON number would round it silently.",
    ),
});

export class UserDataCategoryDto extends createZodDto(userDataCategorySchema) {}

/**
 * A category with no bytes of its own.
 *
 * Note templates are rows of text; there is no storage object behind one, and
 * reporting `bytes: "0"` would invite a client to render a size that is not
 * merely zero but meaningless.
 */
export const userDataCountOnlySchema = z.object({
  count: z.number().int().describe('How many rows of this category the caller owns.'),
});

export class UserDataCountOnlyDto extends createZodDto(userDataCountOnlySchema) {}

/** What `scope: 'everything'` additionally destroys. */
export const userDataCredentialsSchema = z.object({
  aiKeys: z
    .number()
    .int()
    .describe("How many AI provider keys the caller has stored, one per provider."),
  accessTokens: z
    .number()
    .int()
    .describe('How many personal access tokens the caller holds that are not already revoked.'),
});

export class UserDataCredentialsDto extends createZodDto(userDataCredentialsSchema) {}
