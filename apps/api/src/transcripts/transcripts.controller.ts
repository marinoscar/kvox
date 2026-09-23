// =============================================================================
// TranscriptsController (issue #25, epic #19)
// =============================================================================
//
// Twenty-two routes: the ten reads and lifecycle actions of issue #25, the five
// corrections routes of issue #27 — apply a batch of ops, search, browse the
// version history, read one version, restore one — the four sharing routes of
// issue #29, and the three export routes of issue #28: list the formats,
// request an export, poll and download it.
//
// -----------------------------------------------------------------------------
// THE SHARING FOUR, AND THE ONE OF THEM THAT IS NOT OWNER-ONLY
// -----------------------------------------------------------------------------
//
// `GET`, `POST` and `PATCH` under `:id/shares` are owner-only, enforced by
// `require(..., 'own')` inside `TranscriptSharingService` and therefore
// answering the same 404 a stranger gets. `DELETE :id/shares/:userId` is the
// exception: a RECIPIENT passing their OWN user id is leaving, which needs no
// more authority than holding the share did — and so it is gated on
// `transcripts:read`, not `transcripts:write`, because giving up your own
// access is not a write against somebody else's recording.
//
// -----------------------------------------------------------------------------
// TWO PERMISSIONS, AND A SHARE CAPS WHAT EITHER CAN REACH
// -----------------------------------------------------------------------------
//
// `transcripts:read` gates every read; `transcripts:write` gates create and
// the three lifecycle actions. Both are seeded to ALL THREE ROLES, Viewer
// included, because creating a transcript is the action this whole epic exists
// to enable and a brand-new user's default role is Viewer — a permission model
// that made a fresh signup unable to record their first conversation would
// contradict the product's own onboarding (spec §6.2).
//
// The permission is not the whole check. Per-transcript access is decided by
// `TranscriptAccessService`, and NO ACCESS IS A 404 — never a 403 — because
// the existence of a specific transcript id is itself something a stranger has
// no business learning.
//
// ⚠ THERE IS DELIBERATELY NO ADMIN READ-ANY ROUTE HERE, and no permission that
// could gate one. An administrator who configures which provider this
// deployment uses has no path, through any permission this application grants,
// to read a transcript they do not own or hold a share on. Configuring the pipe
// is not the same authority as reading what flows through it (spec §6.2, §10).
//
// -----------------------------------------------------------------------------
// THE WEAK ETAG, AND WHY THE TWO POLLING ROUTES CARRY ONE
// -----------------------------------------------------------------------------
//
// `GET /:id` and `GET /:id/segments` answer a weak ETag (`W/"v<currentVersion>"`,
// see below) and honour `If-None-Match` with a `304`. Issue #30's `useTranscript` hook polls those
// two routes on a 5s/20s adaptive schedule while a transcript is in flight and
// while an editor has it open; the ETag is what makes the common case — the
// answer has not moved — cost headers instead of a body. It is WEAK because
// the representation is semantically, not byte-for-byte, equivalent across
// two responses at the same version: `updatedAt` and the signed URLs inside
// it move without the version doing so.
//
// ⚠ AND IT IS NOT ONLY THE VERSION (#323). Naming an AI-detected speaker for
// the first time ("Speaker A" → "Oscar") deliberately does NOT create a
// version, yet it changes what `GET /:id` says. So the validator is
// `W/"v<currentVersion>"` while nobody has named a speaker — every ETag issued
// before #323 stays valid — and `W/"v<currentVersion>-<fingerprint>"` once
// somebody has, where the fingerprint is the first twelve hex digits of a
// SHA-256 over the sorted identities map (`transcriptETag`). Clients treat the
// value as opaque; nothing may parse a version number out of it.
// =============================================================================

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  CreateTranscriptBodyDto,
  CreateTranscriptResponseDto,
  TranscriptAudioDto,
  TranscriptDetailDto,
  TranscriptListDto,
  TranscriptListItemDto,
  TranscriptListQueryParamsDto,
  TranscriptSegmentsDto,
  TranscriptSummaryDto,
  TranscriptWordsDto,
  TranscriptWordsQueryParamsDto,
  UpdateTranscriptBodyDto,
  createTranscriptSchema,
  transcriptListQuerySchema,
  transcriptWordsQuerySchema,
  updateTranscriptSchema,
  type CreateTranscriptDto,
  type TranscriptListQueryDto,
  type TranscriptWordsQueryDto,
  type UpdateTranscriptDto,
} from './dto/transcript.dto';
import {
  ApplyOperationsBodyDto,
  OperationsConflictDto,
  OperationsResultDto,
  RestoreVersionBodyDto,
  TranscriptSearchDto,
  TranscriptSearchQueryParamsDto,
  TranscriptVersionDetailDto,
  TranscriptVersionsDto,
  TranscriptVersionsQueryParamsDto,
  applyOperationsSchema,
  restoreVersionSchema,
  transcriptSearchQuerySchema,
  transcriptVersionsQuerySchema,
  type ApplyOperationsDto,
  type RestoreVersionDto,
  type TranscriptSearchQueryDto,
  type TranscriptVersionsQueryDto,
} from './dto/transcript-editing.dto';
import {
  CreateTranscriptShareBodyDto,
  TranscriptShareDto,
  TranscriptSharesDto,
  UpdateTranscriptShareBodyDto,
  createTranscriptShareSchema,
  updateTranscriptShareSchema,
  type CreateTranscriptShareDto,
  type UpdateTranscriptShareDto,
} from './dto/transcript-share.dto';
import {
  CreateTranscriptExportBodyDto,
  TranscriptExportDto,
  TranscriptExportersDto,
  createTranscriptExportSchema,
  type CreateTranscriptExportDto,
} from './dto/transcript-export.dto';
import { TranscriptExportService } from './export/transcript-export.service';
import { identitiesFingerprint } from './editing/speaker-identity';
import { TranscriptEditingService } from './transcript-editing.service';
import { TranscriptSharingService } from './transcript-sharing.service';
import { TranscriptsService } from './transcripts.service';

/**
 * The weak validator for a transcript at `version`.
 *
 * WEAK (`W/`) because two responses at the same version are semantically
 * equivalent rather than byte-identical — `updatedAt` moves when a poll writes
 * `last_polled_at`, and the detail response embeds timestamps that are not
 * part of what the version identifies. A strong ETag would be a promise this
 * endpoint cannot keep.
 */
export function versionETag(version: number): string {
  return `W/"v${version}"`;
}

/**
 * The weak validator for a transcript's two polling routes (#323).
 *
 * `versionETag(version)` exactly while the identities map is empty — so every
 * validator a client already holds keeps matching — and the version plus a
 * fingerprint of the map once a speaker has been named, because naming one
 * changes the response without moving the version. See the file header.
 * `versionETag` itself stays as it was: `notes.controller.ts` reuses it, and a
 * note has no speakers to identify.
 */
export function transcriptETag(
  version: number,
  identities: Readonly<Record<string, string>>,
): string {
  const fingerprint = identitiesFingerprint(identities);

  return fingerprint === null ? versionETag(version) : `W/"v${version}-${fingerprint}"`;
}

/**
 * Does the request's `If-None-Match` match `etag`?
 *
 * ⚠ HANDLES A LIST AND `*`, because both are legal. A client may send several
 * validators, and a proxy may rewrite one. Weak comparison is used — which is
 * the ONLY comparison RFC 9110 permits for `If-None-Match` — so `W/"v3"` and
 * `"v3"` match each other, and a caller that stripped the `W/` prefix still
 * gets its 304 rather than a body it already has.
 */
export function matchesETag(header: string | undefined, etag: string): boolean {
  if (!header) return false;

  const normalize = (value: string): string => value.trim().replace(/^W\//, '');
  const wanted = normalize(etag);

  return header
    .split(',')
    .map(normalize)
    .some((candidate) => candidate === '*' || candidate === wanted);
}

@ApiTags('Transcripts')
@Controller('transcripts')
export class TranscriptsController {
  constructor(
    private readonly transcripts: TranscriptsService,
    private readonly editing: TranscriptEditingService,
    private readonly sharing: TranscriptSharingService,
    private readonly exports: TranscriptExportService,
  ) {}

  // ===========================================================================
  // Create
  // ===========================================================================

  @Post()
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_WRITE] })
  @ApiOperation({
    summary: 'Create a transcript and begin its upload',
    description:
      'Creates a transcript in `uploading` and initialises the resumable multipart upload ' +
      'its audio will arrive through, in one call. The response carries both: the ' +
      'transcript row, and the `objectId`, `partSize`, `totalParts` and first batch of ' +
      'presigned PUT URLs the client uploads against.\n\n' +
      'Three pre-flight checks run before anything is created, so a rejected request ' +
      'leaves no half-started upload behind:\n\n' +
      '- **409** when transcription is not configured for this deployment — disabled, no ' +
      'provider chosen, a provider this build does not include, or no API key stored. The ' +
      'request was well formed; the deployment is not ready.\n' +
      '- **400** when the file is larger than the active provider accepts, or is not a ' +
      'type this deployment allows at all.\n' +
      '- **403** when the caller does not hold `transcripts:write`.\n\n' +
      'The upload object is created `managed_by: transcripts`, which makes it invisible to ' +
      '`GET /api/storage/objects` and refuses a generic `DELETE` — only this transcript ' +
      'being deleted removes it.',
  })
  @ApiDataResponse(CreateTranscriptResponseDto, {
    status: 201,
    description: 'Transcript created and upload initialised',
  })
  @ApiResponse({ status: 400, description: 'The file is too large or is not an accepted type' })
  @ApiResponse({ status: 409, description: 'Transcription is not configured for this deployment' })
  async create(
    @Body(new ZodValidationPipe(createTranscriptSchema)) dto: CreateTranscriptDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.transcripts.create(dto, user);
  }

  // ===========================================================================
  // Read
  // ===========================================================================

  @Get()
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'List transcripts',
    description:
      'The transcripts this caller can open: their own, those shared with them, or both. ' +
      'Ordered by `updatedAt` descending and paginated by an opaque **cursor** rather than ' +
      'a page number — every pipeline transition rewrites `updatedAt`, and offset paging ' +
      'over a list that reorders itself while a user scrolls skips rows and repeats ' +
      'others.\n\n' +
      '`status` filters on the TOP-LEVEL status only. Filtering by a sub-pipeline status ' +
      "would require the caller to know that `processing` can mean either sub-pipeline, or " +
      'both.',
  })
  @ApiQuery({ name: 'scope', required: false, enum: ['owned', 'shared', 'all'] })
  @ApiQuery({ name: 'status', required: false, enum: ['uploading', 'processing', 'ready', 'failed', 'deleting'] })
  @ApiQuery({ name: 'q', required: false, type: String, description: 'Case-insensitive title substring' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: '`nextCursor` from the previous page' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1-100 (default 20)' })
  @ApiDataResponse(TranscriptListDto, { description: 'One page of transcripts' })
  async list(
    @Query(new ZodValidationPipe(transcriptListQuerySchema)) query: TranscriptListQueryDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.transcripts.list(query, userId);
  }

  @Get('summary')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'Home-page summary',
    description:
      'Four lists and four counts in one request: what is still in flight, the eight most ' +
      'recently touched transcripts this caller owns, the eight most recent shared with ' +
      'them, the eight most recent of their own that failed, and the totals. Exists so the ' +
      'home page renders in one round trip rather than five. `failed` is capped at eight ' +
      'and owner-scoped; `counts.failed` is the true total.',
  })
  @ApiDataResponse(TranscriptSummaryDto, { description: 'The caller\'s transcript summary' })
  async summary(@CurrentUser('id') userId: string) {
    return this.transcripts.summary(userId);
  }

  // ===========================================================================
  // Exports (issue #28, spec §8)
  // ===========================================================================

  // ⚠ DECLARED BEFORE `@Get(':id')`. Fastify's router would otherwise match
  // `/api/transcripts/exporters` against the uuid parameter route, and
  // `ParseUUIDPipe` would answer 400 for a literal path that exists.
  @Get('exporters')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'List the available export formats',
    description:
      'Every registered exporter, with the options it accepts. The export dialog builds ' +
      'itself from this response rather than from a list of formats compiled into the ' +
      'client, so a deployment that registers a new exporter offers it immediately.\n\n' +
      'Each option carries its `key`, a `label`, a `description` and a `default`. Send the ' +
      'keys you want to change inside `options` on `POST /api/transcripts/{id}/exports`; ' +
      'an unknown key is a **400**, never a silently ignored field.',
  })
  @ApiDataResponse(TranscriptExportersDto, { description: 'The registered export formats' })
  exporters() {
    return this.exports.listExporters();
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'Get one transcript',
    description:
      'Metadata, speakers, all three pipeline statuses, `currentVersion` and the role this ' +
      "caller holds on it.\n\n" +
      'Carries a **weak ETag** — `W/"v<currentVersion>"`, or ' +
      '`W/"v<currentVersion>-<fingerprint>"` once a speaker has been named, because naming ' +
      'a speaker for the first time changes this response without creating a version. ' +
      'Treat it as opaque. A conditional request whose ' +
      '`If-None-Match` matches is answered `304` with no body, which is what makes polling ' +
      'this route while nothing changes nearly free.\n\n' +
      'A caller with no access gets **404**, never 403: the existence of a specific ' +
      'transcript id is itself information a stranger has no business learning.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(TranscriptDetailDto, { description: 'The transcript' })
  @ApiResponse({ status: 304, description: 'Unchanged since the `If-None-Match` version' })
  @ApiResponse({ status: 404, description: 'No such transcript, or no access to it' })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { payload, version, identities } = await this.transcripts.detailConditional(id, user);

    return this.conditional(transcriptETag(version, identities), payload, request, reply);
  }

  @Get(':id/segments')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'Get a transcript\'s segments',
    description:
      'Every segment in reading order, **without word timings** — those are the single ' +
      'largest thing in this schema, and a segment list that carried them would be tens of ' +
      'megabytes for a view that renders text. Fetch them per time window from ' +
      '`GET /api/transcripts/{id}/words`.\n\n' +
      'Carries the same weak ETag as `GET /api/transcripts/{id}` and honours ' +
      '`If-None-Match` with a `304`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(TranscriptSegmentsDto, { description: 'The transcript\'s segments' })
  @ApiResponse({ status: 304, description: 'Unchanged since the `If-None-Match` version' })
  @ApiResponse({ status: 404, description: 'No such transcript, or no access to it' })
  async segments(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { payload, version, identities } = await this.transcripts.segmentsConditional(id, user);

    return this.conditional(transcriptETag(version, identities), payload, request, reply);
  }

  @Get(':id/words')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'Word timings for a time window',
    description:
      'Per-word start, end and confidence for every segment overlapping `[fromMs, toMs)`, ' +
      'for word-level highlighting during playback.\n\n' +
      'A **window**, never the whole transcript: a ten-hour recording\'s word index is ' +
      'hundreds of megabytes. `toMs` defaults to five minutes past `fromMs` and is capped ' +
      'at thirty minutes past it; a wider request is silently narrowed rather than ' +
      'refused, and the response echoes the window actually served.\n\n' +
      'Segments are selected by **overlap**, not containment — one straddling the ' +
      'window\'s start carries the words the player is about to highlight.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'fromMs', required: false, type: Number })
  @ApiQuery({ name: 'toMs', required: false, type: Number })
  @ApiDataResponse(TranscriptWordsDto, { description: 'Word timings for the window' })
  @ApiResponse({ status: 404, description: 'No such transcript, or no access to it' })
  async words(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(transcriptWordsQuerySchema)) query: TranscriptWordsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.transcripts.words(id, query, user);
  }

  @Get(':id/audio')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'A signed URL for the audio',
    description:
      'A short-lived signed GET for this transcript\'s audio: the small, seekable playback ' +
      'rendition when one is ready, the original upload otherwise. Six-hour TTL — an ' +
      '`<audio>` element holds the URL for as long as somebody is listening, and a ' +
      'three-hour recording outlives a one-hour URL halfway through.\n\n' +
      '`kind` says which file was signed, so a client can decide whether to trust the ' +
      'browser to play it.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(TranscriptAudioDto, { description: 'A signed URL for the audio' })
  @ApiResponse({ status: 404, description: 'No such transcript, no access, or no playable audio' })
  async audio(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.transcripts.audio(id, user);
  }

  // ===========================================================================
  // Write and lifecycle
  // ===========================================================================

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_WRITE] })
  @ApiOperation({
    summary: 'Rename a transcript',
    description:
      'Changes the title. **Not versioned**: a title is metadata about the recording, not ' +
      'content of it, so recording a rename as a version would put a no-op in the edit ' +
      'history that a later restore could "undo" into a name nobody chose.\n\n' +
      'Requires `edit` access — the owner, or an `editor` share — **and** ' +
      '`transcripts:write`. A share caps the ceiling an RBAC permission can raise a user ' +
      'to; it never raises the floor.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(TranscriptDetailDto, { description: 'The renamed transcript' })
  @ApiResponse({ status: 404, description: 'No such transcript, or no edit access to it' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateTranscriptSchema)) dto: UpdateTranscriptDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.transcripts.updateTitle(id, dto.title, user);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a transcript',
    description:
      'Owner only. Moves the transcript to `deleting` and queues `transcript.purge`, which ' +
      'removes every managed storage object it ever owned — the original upload, the ' +
      'playback rendition, the gzipped raw provider result, every snapshot, every export — ' +
      "deletes the provider's own copy if it still holds one, and only then deletes the " +
      'rows.\n\n' +
      '`deleting` is a real, visible status rather than an immediate row delete because ' +
      'purging multi-gigabyte objects is long-running work. **There is no path back.**',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deletion started' })
  @ApiResponse({ status: 404, description: 'No such transcript, or the caller is not its owner' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.transcripts.remove(id, user);
  }

  @Post(':id/retry')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_WRITE] })
  @ApiOperation({
    summary: 'Retry a failed transcript',
    description:
      'Owner only. Re-runs the stage that failed — and **the stage is derived from the ' +
      'row, not chosen by the caller**: a transcript the provider already accepted is ' +
      're-polled, and only one that never got a provider job is re-submitted. Letting a ' +
      'client name the stage would allow a second remote job, and a second bill, for one ' +
      'recording.\n\n' +
      'The audio is not re-uploaded; it is still in storage. **409** when it is not — or ' +
      'when the transcript is already complete, still uploading, or being deleted.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(TranscriptDetailDto, { description: 'The transcript, restarted' })
  @ApiResponse({ status: 409, description: 'This transcript cannot be retried in its current state' })
  @ApiResponse({ status: 404, description: 'No such transcript, or the caller is not its owner' })
  async retry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.transcripts.retry(id, user);
  }

  @Post(':id/cancel')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_WRITE] })
  @ApiOperation({
    summary: 'Cancel a transcript in flight',
    description:
      'Owner only. Cancels the job on the provider when the provider supports cancellation, ' +
      'and marks the transcript `failed` / `cancelled` either way — a vendor that will not ' +
      'answer must not stop the owner from stopping waiting. A cancelled transcript can be ' +
      'retried, which re-submits it rather than polling the abandoned remote job.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(TranscriptDetailDto, { description: 'The cancelled transcript' })
  @ApiResponse({ status: 409, description: 'A ready or deleting transcript cannot be cancelled' })
  @ApiResponse({ status: 404, description: 'No such transcript, or the caller is not its owner' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.transcripts.cancel(id, user);
  }

  // ===========================================================================
  // Corrections, versions and restore (issue #27, spec §4-§5)
  // ===========================================================================

  @Post(':id/operations')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_WRITE] })
  @ApiOperation({
    summary: 'Apply a batch of corrections',
    description:
      'The write half of "AI proposes, the user controls the truth". Up to 200 ops are ' +
      'applied **in one transaction** and recorded as a new version that can be browsed ' +
      'and restored; nothing is ever overwritten in place.\n\n' +
      '**Ops**: `segment.update_text`, `segment.set_speaker`, `segment.split` (by ' +
      '`atWordIndex` **or** `atCharOffset`, never both), `segment.join` (adjacent only), ' +
      '`segment.delete`, `speaker.rename`, `speaker.create`, `speaker.merge`, and ' +
      '`transcript.find_replace`.\n\n' +
      '`transcript.find_replace` is **expanded server-side into concrete ' +
      '`segment.update_text` ops before the version is recorded**, so replaying a version ' +
      'can never be changed later by a change to how matches are found. Matching is ' +
      'literal — never a regular expression — with optional case sensitivity, ' +
      'Unicode-aware whole-word boundaries, and an optional speaker scope.\n\n' +
      '**Concurrency (409)**: `baseVersion` is informational and may be stale — every ' +
      "op's own `rev` is checked against the current row instead, so two editors " +
      'correcting **different** lines both succeed. Two ops against the same stale entity ' +
      'answer `409` whose `details` carries ' +
      '`{ currentVersion, conflicts: [{ entity, id, current }] }`, naming every conflict at ' +
      'once so one re-fetch resolves them all. `current` is `null` for an entity another ' +
      'editor deleted.\n\n' +
      '**Idempotency**: a repeated `clientBatchId` returns the **original** result with ' +
      '`idempotentReplay: true` and creates no second version, so a retry after a dropped ' +
      'connection is always safe.\n\n' +
      'Word timings survive the edit: unchanged words keep the provider\'s own times, ' +
      'changed ones are re-aligned by token LCS and the segment becomes ' +
      '`wordsAlignment: interpolated`. A split divides the word array; a join ' +
      'concatenates it.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: ApplyOperationsBodyDto })
  @ApiDataResponse(OperationsResultDto, { description: 'The new version and the corrected state' })
  @ApiResponse({ status: 400, description: 'An op is structurally impossible, or the batch is malformed' })
  @ApiResponse({ status: 403, description: 'The caller can view this transcript but lacks `transcripts:write`' })
  @ApiResponse({ status: 404, description: 'No such transcript, or no edit access to it' })
  @ApiResponse({
    status: 409,
    description: 'A stale `rev` — `details` names every conflicting entity',
    type: OperationsConflictDto,
  })
  async operations(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(applyOperationsSchema)) dto: ApplyOperationsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.editing.applyOperations(id, dto, user);
  }

  @Get(':id/search')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'Find text in a transcript',
    description:
      'The preview behind the find & replace UI: every occurrence of `q`, with the segment ' +
      'it is in, where in the media that segment starts, the offsets inside its text, and ' +
      'a short excerpt.\n\n' +
      'Matching is **literal, never a regular expression** — a regex engine fed end-user ' +
      'input is a ReDoS surface and is the wrong tool for somebody correcting a misheard ' +
      'name. `matchCase` and `wholeWord` are the two options, and `wholeWord` uses ' +
      'Unicode-aware boundaries rather than `\\b`, so a search for `os` does not match ' +
      'inside `José`.\n\n' +
      '`total` is always the exact number of occurrences, even when `matches` was ' +
      'truncated to `limit` — a preview that under-reported would understate what a ' +
      'replacement is about to rewrite.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'q', required: true, type: String })
  @ApiQuery({ name: 'matchCase', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'wholeWord', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'speakerId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1-500 (default 500)' })
  @ApiDataResponse(TranscriptSearchDto, { description: 'Matches and the exact total' })
  @ApiResponse({ status: 404, description: 'No such transcript, or no access to it' })
  async search(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(transcriptSearchQuerySchema)) query: TranscriptSearchQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.editing.search(id, query, user);
  }

  @Get(':id/versions')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'Browse the version history',
    description:
      'Every save, newest first, cursor-paginated. Each entry carries the human-readable ' +
      '`summary` generated when it was recorded, who saved it, and — for a restore — which ' +
      'version it was restored from.\n\n' +
      '**`author: null` means the AI**, not a missing value: version 1 is `ai_original` ' +
      'and is the provider\'s own output. It is permanent for the life of the transcript ' +
      'and nothing in this API ever deletes a version row.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: '`nextCursor` from the previous page' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1-100 (default 20)' })
  @ApiDataResponse(TranscriptVersionsDto, { description: 'One page of versions' })
  @ApiResponse({ status: 404, description: 'No such transcript, or no access to it' })
  async versions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(transcriptVersionsQuerySchema)) query: TranscriptVersionsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.editing.listVersions(id, query, user);
  }

  @Get(':id/versions/:version')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'Read one version',
    description:
      'The transcript as it stood at this version: the nearest snapshot at or before it, ' +
      'with every later version\'s ops replayed through the same reducers the live edit ' +
      'path uses — so what you read here is what was actually saved.\n\n' +
      'Segments come back **without word timings**, exactly as ' +
      '`GET /api/transcripts/{id}/segments` does, because a history browser renders text.' +
      '\n\n**409** while a version older than the first snapshot is still unreachable: ' +
      'version 1 cannot be rebuilt from ops (it is what the provider said, not a change to ' +
      'anything), so it is reachable once its `transcript.snapshot` job has run.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'version', type: Number })
  @ApiDataResponse(TranscriptVersionDetailDto, { description: 'The materialized version' })
  @ApiResponse({ status: 404, description: 'No such transcript or version, or no access' })
  @ApiResponse({ status: 409, description: 'This version has no snapshot to rebuild from yet' })
  async version(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentUser() user: RequestUser,
  ) {
    return this.editing.getVersion(id, version, user);
  }

  @Post(':id/versions/:version/restore')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_WRITE] })
  @ApiOperation({
    summary: 'Restore an earlier version',
    description:
      '**History is never rewritten.** A restore records a NEW version ' +
      '(`kind: restore`, `ops: [{ op: "restore", fromVersion }]`), replaces the ' +
      'current-state tables with that version\'s content in one transaction, and queues a ' +
      'snapshot. Every version in between — including the one that existed immediately ' +
      'before this call — stays exactly as it was, and **version 1, the AI original, is ' +
      'always retrievable**.\n\n' +
      '`baseVersion` **must equal the transcript\'s current version**, unlike ' +
      '`POST /:id/operations` where it is informational: a correction batch carries a ' +
      '`rev` on every op that says what it expects, and a restore carries no such thing — ' +
      'so a stale view means asking to discard edits the caller has never seen.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'version', type: Number })
  @ApiBody({ type: RestoreVersionBodyDto })
  @ApiDataResponse(OperationsResultDto, { description: 'The new `restore` version and its state' })
  @ApiResponse({ status: 404, description: 'No such transcript or version, or no edit access' })
  @ApiResponse({ status: 409, description: '`baseVersion` is stale, or that version is already current' })
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Body(new ZodValidationPipe(restoreVersionSchema)) dto: RestoreVersionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.editing.restore(id, version, dto, user);
  }

  @Post(':id/exports')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'Export a transcript',
    description:
      'Renders one version of this transcript into one format, as a **queue job** — there ' +
      'is no size threshold below which an export runs inside the request, because a ' +
      'threshold is two code paths where the fast one breaks on the first unusually large ' +
      'document.\n\n' +
      '**202** with the new export when a render was queued. **200** when an export of the ' +
      'same version, format and options already exists and has not expired: the identical ' +
      'request produces the identical file, so it is returned rather than rendered again. ' +
      'The `reused` field says which happened, for a client that cannot see the status ' +
      'line.\n\n' +
      '`version` defaults to the current version; any version in the history may be ' +
      'exported and the export contains **that** version\'s content. `options` are ' +
      "validated against the chosen format's own schema from " +
      '`GET /api/transcripts/exporters` — an unknown key is a 400.\n\n' +
      'Requires **view** access, which an `editor` or `viewer` share both satisfy: taking ' +
      'a conversation you were shown out of this application is a read.\n\n' +
      'Exports expire after **7 days** and their files are deleted by the housekeeping ' +
      'sweep. Nothing is lost — requesting the identical export again produces the ' +
      'identical file.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: CreateTranscriptExportBodyDto })
  @ApiDataResponse(TranscriptExportDto, {
    status: 202,
    description: 'A render was queued; poll the export for its status',
  })
  @ApiResponse({ status: 200, description: 'An identical, unexpired export already existed' })
  @ApiResponse({ status: 400, description: 'Unknown format, or an option that format does not accept' })
  @ApiResponse({ status: 404, description: 'No such transcript or version, or no access to it' })
  async createExport(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createTranscriptExportSchema)) dto: CreateTranscriptExportDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.exports.requestExport(id, dto, user);

    reply.status(result.created ? HttpStatus.ACCEPTED : HttpStatus.OK);

    return result.export;
  }

  @Get(':id/exports/:exportId')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'Get an export',
    description:
      'The export\'s status, and — once it is `ready` — a short-lived signed ' +
      '`downloadUrl` that serves the file as an attachment named ' +
      '`<title> (v<n>).<ext>`.\n\n' +
      'Poll this while `status` is `pending`. A `failed` export carries the reason in ' +
      '`error`; requesting the same export again queues a fresh render rather than ' +
      'returning the failure, because a failed row is never reused.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'exportId', type: String, format: 'uuid' })
  @ApiDataResponse(TranscriptExportDto, { description: 'The export' })
  @ApiResponse({ status: 404, description: 'No such transcript or export, or no access to it' })
  async getExport(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('exportId', ParseUUIDPipe) exportId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.exports.getExport(id, exportId, user);
  }

  // ===========================================================================
  // Sharing (issue #29, spec §6.3)
  // ===========================================================================

  @Get(':id/shares')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'List who a transcript is shared with',
    description:
      'Owner only. Every share on this transcript, oldest first, with each recipient\'s ' +
      'address, display name and role.\n\n' +
      '**Owner only, not viewer-or-better**, deliberately: who else can read a recording ' +
      'is a fact about those other people, not about the caller. A recipient gets the ' +
      'same **404** a stranger gets.\n\n' +
      'Not paginated. This is the list inside one dialog, for a private conversation ' +
      'shared by typing addresses one at a time.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(TranscriptSharesDto, { description: 'Everyone this transcript is shared with' })
  @ApiResponse({ status: 404, description: 'No such transcript, or the caller is not its owner' })
  async shares(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.sharing.list(id, user);
  }

  @Post(':id/shares')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_WRITE] })
  @ApiOperation({
    summary: 'Share a transcript with somebody',
    description:
      'Owner only. Grants `viewer` (read, play, export) or `editor` (everything a viewer ' +
      'can do, plus corrections, which create versions).\n\n' +
      'The recipient is found by **exact, case-insensitive email** — never a prefix, never ' +
      'a listing, one address per call. An address with no **active** account answers a ' +
      'generic **404** that names neither the address nor any user, and a **deactivated** ' +
      'account is indistinguishable from one that never existed: telling the two apart is ' +
      'precisely the account-enumeration oracle this shape exists to close. For the same ' +
      'reason the lookup is **rate limited per caller**, and a run of misses answers ' +
      '**429** — a generic message does not stop an enumerator reading the status code.\n\n' +
      'Sharing again with somebody who already holds a share **updates their role** rather ' +
      'than failing: the email field does not know who is already on the list.\n\n' +
      'The recipient — and only the recipient — is notified, after the grant has ' +
      'committed. Re-submitting the same role notifies nobody.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: CreateTranscriptShareBodyDto })
  @ApiDataResponse(TranscriptShareDto, { status: 201, description: 'The share that now exists' })
  @ApiResponse({
    status: 400,
    description:
      'The address is not a valid email, the role is not one of the two, or the address is ' +
      'the caller\'s own — which is a **400**, not the generic 404, because there is nothing ' +
      'to conceal from somebody about their own account',
  })
  @ApiResponse({ status: 404, description: 'No such transcript, the caller is not its owner, or no user has that address' })
  @ApiResponse({ status: 429, description: 'Too many lookups for addresses with no account' })
  async addShare(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createTranscriptShareSchema)) dto: CreateTranscriptShareDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.sharing.add(id, dto, user);
  }

  @Patch(':id/shares/:userId')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_WRITE] })
  @ApiOperation({
    summary: 'Change what a share grants',
    description:
      'Owner only. Promotes a viewer to editor or demotes an editor to viewer. Takes ' +
      'effect on the **next request** — there is no cached grant anywhere, so a demoted ' +
      'editor\'s next correction is refused without anything having to be invalidated.\n\n' +
      'A promotion notifies the recipient; a **demotion is silent**, because the "shared ' +
      'with you" message is simply the wrong message for "you can no longer correct this".',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'userId', type: String, format: 'uuid', description: 'The RECIPIENT\'s user id, not the share row id' })
  @ApiBody({ type: UpdateTranscriptShareBodyDto })
  @ApiDataResponse(TranscriptShareDto, { description: 'The updated share' })
  @ApiResponse({ status: 404, description: 'No such transcript or share, or the caller is not the owner' })
  async updateShare(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(updateTranscriptShareSchema)) dto: UpdateTranscriptShareDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.sharing.update(id, userId, dto, user);
  }

  @Delete(':id/shares/:userId')
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke a share, or leave one',
    description:
      'Two callers, one route. The **owner** may remove anybody; a **recipient** may pass ' +
      'their own user id to give up their own access ("leave"). Nobody else can remove ' +
      'anybody — an editor cannot revoke a viewer.\n\n' +
      'Revocation takes effect on the **next request**. There is no cached grant, no ' +
      'claim to re-issue and nothing to invalidate: the access check reads the share table ' +
      'every time, so deleting the row **is** the revocation.\n\n' +
      'The person removed is **not** notified. An owner is entitled to un-share a private ' +
      'conversation without composing an explanation.\n\n' +
      'Gated on `transcripts:read`, not `transcripts:write`: giving up your own access is ' +
      'not a write against somebody else\'s recording, and a role change that removed ' +
      '`transcripts:write` must not trap a recipient in a share they want out of.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'userId', type: String, format: 'uuid', description: 'The RECIPIENT\'s user id — their own, to leave' })
  @ApiResponse({ status: 204, description: 'The share is gone' })
  @ApiResponse({ status: 404, description: 'No such transcript or share, or the caller may not remove it' })
  async removeShare(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.sharing.remove(id, userId, user);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Stamp the ETag, and answer `304` when the caller already has this
   * representation (`transcriptETag` — the version, and the speaker names).
   *
   * The `undefined` return is what `TransformInterceptor` recognises — it
   * skips the `{ data, meta }` envelope entirely once the status is 304, so
   * the response carries no body, which is what RFC 9110 requires of one.
   */
  private conditional<T>(
    etag: string,
    payload: T,
    request: FastifyRequest,
    reply: FastifyReply,
  ): T | undefined {
    reply.header('ETag', etag);
    // A conditional request is only useful if an intermediary does not serve a
    // cached copy without asking; `private, no-cache` says "re-validate every
    // time, and never store this in a shared cache" — which is the correct
    // posture for a per-user, access-controlled resource.
    reply.header('Cache-Control', 'private, no-cache');

    if (matchesETag(request.headers['if-none-match'], etag)) {
      reply.status(HttpStatus.NOT_MODIFIED);

      return undefined;
    }

    return payload;
  }
}
