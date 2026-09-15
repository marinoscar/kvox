// =============================================================================
// THE CHUNKER'S PUBLIC SURFACE (issue #186, epic #165 — Semantic Search)
// =============================================================================
//
// One import path for the `search.index` job of a later issue, so that a
// consumer never has to know whether `chunkNote` lives beside `contentHash` or
// two files away from it.
//
// ⚠ EVERYTHING RE-EXPORTED HERE IS PURE. Nothing in this directory imports
// `PrismaService`, `@nestjs/common`, or a Prisma model type; nothing reads a
// clock, a random source, mutable module state or a locale. That is what makes
// the content hash a function of the text and nothing else, and it is what
// makes incremental re-indexing — the economic argument for this whole epic —
// work at all. `chunk.types.ts`'s header carries the full argument, and cites
// the precedent this follows: `apps/api/src/transcripts/editing/`, which holds
// exactly this discipline so that replaying a version log agrees with the live
// tables by construction. `index.spec.ts` is the executable form of the rule.
//
// There is deliberately NO NestJS module, NO provider and NO dependency
// injection here. A `@Injectable()` chunker would be one constructor parameter
// away from holding a repository, and the first thing anybody would reach for
// when the chunker needed to know a setting. Plain functions make that reach
// visible in a diff.
// =============================================================================

export * from './chunk.types';
export * from './chunk-packer';
export * from './content-hash';
export * from './note-chunker';
export * from './transcript-chunker';
