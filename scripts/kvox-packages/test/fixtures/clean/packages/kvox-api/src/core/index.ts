import { z } from 'zod';

/**
 * A comment that quotes an import must not count as one:
 *
 * ```ts
 * import { AiService } from '@marinoscar/platform-api/ai';
 * ```
 */
export const NAME = z.string().parse('core');
