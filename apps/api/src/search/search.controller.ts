// =============================================================================
// SearchController (issue #175, epic #164)
// =============================================================================
//
// One route: `GET /api/search`. Ranked full-text search over transcript and
// note CONTENT, rolled up to documents.
//
// -----------------------------------------------------------------------------
// WHY THE ROUTE DECLARES NO PERMISSION, AND WHY A PARTIAL ANSWER IS NOT A 403
// -----------------------------------------------------------------------------
//
// This endpoint reads two modules' data, each with its own read permission:
// `transcripts:read` (`transcripts.controller.ts`) and `notes:read`
// (`notes.controller.ts`). Those are the exact strings those controllers
// enforce - the same "name the permission the API actually checks" discipline
// the admin section registry's `permission` field follows, applied to an
// endpoint instead of a card.
//
// The requirement is EITHER of them, and `PermissionsGuard` cannot express
// that: it requires ALL declared permissions (see the guard - `every`, not
// `some`). Declaring both would 403 a caller holding one, which is exactly the
// caller the rule below exists for; declaring one would be a lie about what
// this route reads. So `@Auth()` carries the authentication requirement, and
// `SearchService` enforces "at least one of the two" plus the per-type
// narrowing. That narrowing is where the interesting decision is:
//
//   A CALLER WHO ASKS FOR BOTH TYPES AND HOLDS ONE PERMISSION GETS THE ONE
//   THEY MAY HAVE - NOT A 403.
//
// The alternative is a dead end. A user opens a search box, types a word,
// and is told "Forbidden" - with nothing on screen saying which half of the
// request was the problem, and no way to find out except guessing at a `types`
// parameter they never knew existed. Meanwhile the notes they are entitled to
// search, and which match, sit there unreturned. A partial answer is strictly
// more useful and strictly no less safe: nothing is disclosed that the
// caller's own permissions do not already grant.
//
// It is not silent, either. The response carries `searchedTypes` - the types
// actually searched - so a client can render "searched your notes" rather than
// implying it searched everything. An answer that quietly omitted a whole
// document type would be the genuinely bad outcome here, and that field is
// what stops it.
//
// In practice this is nearly invisible: `transcripts:read` and `notes:read`
// are both seeded to all three roles, so almost every caller holds both. It
// still has to be right, because "rarely reached" and "never reached" are
// different things, and the path that is rarely reached is the one nobody
// tests by hand.
//
// -----------------------------------------------------------------------------
// WHAT THIS ROUTE DOES NOT CHANGE
// -----------------------------------------------------------------------------
//
// `GET /api/transcripts?q=` and `GET /api/notes?q=` keep their
// case-insensitive TITLE SUBSTRING filter and their `(updatedAt, id)` keyset
// cursor, unchanged. They are list endpoints with a filter; this is a search
// endpoint with a ranking, and they page differently because they are ordered
// differently. The one place they meet is the degraded path: an all-stopword
// query here falls back to precisely their behaviour and says so with
// `degraded: "stopwords"`.
// =============================================================================

import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_CANDIDATE_DOCUMENTS,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_LENGTH,
  SearchResponseDto,
  searchQuerySchema,
  type SearchQueryDto,
} from './dto/search.dto';
import { SearchService } from './search.service';

@ApiTags('Search')
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @Auth()
  @ApiOperation({
    summary: 'Search transcripts and notes',
    description:
      'Ranked full-text search over the **content** of your transcripts and notes, not just ' +
      'their titles: a word spoken once in the middle of a three-hour recording finds that ' +
      'recording, and a term that appears only in a note body finds that note.\n\n' +
      '**Ranking is hybrid, and there is deliberately no keyword/semantic switch.** Two arms ' +
      'run and their results are fused: a **full-text** arm scored with `ts_rank_cd` (cover ' +
      'density, which rewards query terms appearing close together rather than simply often), ' +
      'and a **semantic** arm that compares an embedding of your query against embeddings of ' +
      'your content, so a paraphrase finds the recording even when it shares no word with it. ' +
      'In both arms a document is scored by the **best** passage it contains, never by the sum ' +
      'of its passages, so a short conversation that is *about* a term outranks a long one that ' +
      'mentions it thirty times in passing.\n\n' +
      'The two are combined by **reciprocal rank fusion** - `score` is ' +
      '`Σ 1/(60 + rank)` over the arms that found the document, so it uses only each arm\'s ' +
      'ordering and never their raw scores, which live on incomparable scales. A document found ' +
      'by both arms generally outranks one found strongly by a single arm. `score` is ' +
      'comparable within one response and meaningless across two.\n\n' +
      '**The semantic arm may be unavailable, and says so rather than failing.** Your content ' +
      'is embedded with its owner\'s API key when it is indexed; your **query** is embedded ' +
      'with **your own** key at search time. If you have not saved one, or the provider is ' +
      'unreachable, or nothing has been indexed yet, this endpoint still answers **200** with ' +
      'the full-text ranking - unchanged - and sets `semantic: false` plus a `semanticReason` ' +
      '(`ai_key_missing`, `ai_not_configured`, `embedding_unsupported`, `no_indexed_content`, ' +
      '`embedding_failed`). `unindexedCount` reports how many of **your own** documents, among ' +
      'the types searched, are not in the semantic index and so cannot be found by meaning ' +
      'however well they match.\n\n' +
      '**Snippets.** Each result carries up to three snippets saying why it matched, most ' +
      'relevant first. `html` is **already escaped**: the only markup in it is balanced ' +
      '`<mark>...</mark>` around the hits, and everything else - including any angle bracket ' +
      'the source text happened to contain - is escaped text. A transcript snippet carries ' +
      '`startMs` so a client can seek to it.\n\n' +
      '**Paging.** Results come from a bounded candidate window of at most ' +
      `${MAX_CANDIDATE_DOCUMENTS} documents, paged by an opaque \`cursor\`. There is ` +
      'deliberately **no `total`**: `matchedDocuments` counts the window and `truncated` says ' +
      'whether it filled up, so `truncated: false` makes the count exact and `truncated: true` ' +
      'makes it a floor.\n\n' +
      '⚠ **A cursor is tied to the search that produced it** - the query text, the type ' +
      'filter, you, the ranking model, and whether the semantic arm ran. Presented against a ' +
      'different search it is refused ' +
      'with a **400** rather than silently restarting: on a relevance list, page 1 served ' +
      'again is indistinguishable from a real page 2, and a user would scroll the same rows ' +
      'forever believing they were making progress.\n\n' +
      '**All-stopword queries degrade, they do not fail.** `the and of` parses to an empty ' +
      'text-search query that matches nothing, so this endpoint falls back to the ' +
      'case-insensitive **title** match the list endpoints already have and sets ' +
      '`degraded: "stopwords"` so a client can say which kind of answer it is showing.\n\n' +
      '**Permissions.** Transcripts need `transcripts:read`, notes need `notes:read`; both are ' +
      'seeded to every role. Holding only one and asking for both returns the half you may ' +
      'have, **not a 403** - `searchedTypes` reports what was actually searched. A caller ' +
      'holding neither gets a 403.\n\n' +
      'Notes are **not shareable** and there is no administrator read-any for either type, so ' +
      'this endpoint can only ever return your own documents plus transcripts somebody shared ' +
      'with you.',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    type: String,
    description: `The search text. 1-${MAX_SEARCH_QUERY_LENGTH} characters.`,
  })
  @ApiQuery({
    name: 'types',
    required: false,
    type: String,
    description:
      'Comma-separated document types to search: `transcript`, `note`, or both. Defaults to ' +
      'both. An empty or unrecognised value is a 400 rather than a silent widening.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Results per page, 1-${MAX_SEARCH_LIMIT} (default ${DEFAULT_SEARCH_LIMIT}).`,
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description: 'An opaque cursor from a previous response. Tied to that exact search.',
  })
  @ApiDataResponse(SearchResponseDto, {
    description: 'The page, the window size, and what was actually searched',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad `q`/`types`/`limit`, or a cursor from a different search',
  })
  async searchAll(
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.search.search(query, user);
  }
}
