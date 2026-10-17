// =============================================================================
// Compile-time proof that the application's Prisma client satisfies every slice
// (issue #492, epic #491)
// =============================================================================
//
// Each domain slice of `@marinoscar/kvox-api` declares, in
// `src/<slice>/data/<slice>-db.ts`, structural row types for the tables it owns
// and a narrowed client type (`KvoxTranscriptsDb`, ...). It injects `KVOX_PRISMA`
// and casts once. The cast is only safe while the real generated client has the
// delegates and columns the slice reads, so this file assigns the application's
// `PrismaService` to each narrowed type: a schema change that breaks a slice
// fails `npm run typecheck --workspace=api` at this line, not at runtime.
//
// It has no runtime behaviour and no test runner: `tsconfig.json` includes it
// (`test/kvox/*.typecheck.ts`), and `tsconfig.build.json` does not.
//
// TRANSCRIPTION NEEDS NO PRISMA. It reads and writes through the settings,
// secrets and audit ports only, so it adds no line here. The first line is search's
// (#494); the transcripts slice (6.2) adds:
//
//   import type { KvoxTranscriptsDb } from '@marinoscar/kvox-api/transcripts';
//   const _transcripts: KvoxTranscriptsDb = null as unknown as KvoxHostPrisma;
//
// Keep one line per slice, named `_<slice>`.
// =============================================================================

import type { PrismaService } from '../../src/prisma/prisma.service';

/** The type every slice line assigns from. */
export type KvoxHostPrisma = PrismaService;

import type { KvoxSearchDb } from '@marinoscar/kvox-api/search';

/**
 * Search (#494): the delegates `searchChunk`, `searchEmbedding` and `searchIndexState`
 * with exactly the arguments and result columns the slice uses, plus the raw methods.
 * Its reads of the transcripts and notes tables are raw SQL, so those delegates are
 * not part of the shape.
 */
export const _search: KvoxSearchDb = null as unknown as KvoxHostPrisma;
