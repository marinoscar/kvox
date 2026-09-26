import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import {
  AddItemBodyDto,
  BulkDecisionBodyDto,
  BulkDecisionResponseDto,
  CommitResponseDto,
  EmptyProposalBodyDto,
  ItemDecisionResponseDto,
  NoteProposalResponseDto,
  PatchItemBodyDto,
  ProposalDetailDto,
  ProposalListResponseDto,
  ProposalResponseDto,
  RevertBodyDto,
  RevertResponseDto,
  addItemSchema,
  bulkDecisionSchema,
  emptyBodySchema,
  getProposalQuerySchema,
  listProposalsQuerySchema,
  patchItemSchema,
  revertBodySchema,
  type AddItemDto,
  type BulkDecisionDto,
  type BulkDecisionResponse,
  type CommitResponse,
  type GetProposalQuery,
  type ItemDecisionResponse,
  type ListProposalsQuery,
  type NoteProposalResponse,
  type PatchItemDto,
  type ProposalDetail,
  type ProposalListResponse,
  type ProposalResponse,
  type RevertBody,
  type RevertResponse,
} from './dto/proposal.dto';
import { ProposalCommitService } from './proposal-commit.service';
import { ProposalRevertService } from './proposal-revert.service';
import { ProposalsService } from './proposals.service';

// =============================================================================
// GraphProposalsController (#366, epic #346; docs/specs/ontology.md §8, §12, §19)
// =============================================================================
//
// The review surface for graph proposals: read them, record a decision per
// row (or in bulk), add what the model missed from a text selection, commit
// ("Send to graph"), discard, and revert a commit.
//
// PER-ROUTE `@Auth` — `graph:read` for reads, `graph:write` for every write.
// Every proposal is owner-only through `GraphAccessService`: a missing
// proposal and another user's are the SAME 404; your own without
// `graph:write` is a 403. There is no read-any.
// =============================================================================

const NOT_FOUND = 'No such proposal, or not yours (the same answer either way).';
const NOT_DRAFT = '`details.reason: "proposal_not_draft"` — the proposal has left `draft`.';

const EMPTY_PIPE = new ZodValidationPipe(emptyBodySchema);
const REVERT_PIPE = new ZodValidationPipe(revertBodySchema);

@ApiTags('Graph')
@Controller('graph')
export class GraphProposalsController {
  constructor(
    private readonly proposals: ProposalsService,
    private readonly commits: ProposalCommitService,
    private readonly reverts: ProposalRevertService,
  ) {}

  @Get('proposals')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'List your graph proposals',
    description:
      'Your proposals, newest first (`createdAt desc, id desc`), keyset-paginated with an opaque ' +
      '`cursor`. `status` defaults to `draft`. `transcriptId` finds proposals whose note came from ' +
      'that transcript, directly or through a chain of notes. Requires `graph:read`. **400**: an ' +
      'invalid cursor or query.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['extracting', 'draft', 'committed', 'discarded', 'failed', 'reverted'] })
  @ApiQuery({ name: 'kind', required: false, enum: ['extraction', 'import', 'resolution'] })
  @ApiQuery({ name: 'noteId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'transcriptId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1–50, default 20' })
  @ApiDataResponse(ProposalListResponseDto, { description: 'One page of proposal summaries' })
  @ApiResponse({ status: 400, description: 'Invalid query or cursor' })
  async list(
    @Query(new ZodValidationPipe(listProposalsQuerySchema)) query: ListProposalsQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<ProposalListResponse> {
    return this.proposals.list(user, query);
  }

  @Get('proposals/:id')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: 'Get a graph proposal',
    description:
      'The proposal, its counts, and every row with its effective payload, server-rendered ' +
      '`display` strings, review group, resolution, flags and evidence (each citation marked ' +
      '`stale` when its text changed since). `?include=context` adds the exact prompt the ' +
      'extraction sent — your own data. Requires `graph:read`. **404**: ' + NOT_FOUND,
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'include', required: false, enum: ['context'] })
  @ApiDataResponse(ProposalDetailDto, { description: 'The proposal and its rows' })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(getProposalQuerySchema)) query: GetProposalQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<ProposalDetail> {
    return this.proposals.get(user, id, query.include === 'context');
  }

  @Get('notes/:noteId/proposal')
  @Auth({ permissions: [PERMISSIONS.GRAPH_READ] })
  @ApiOperation({
    summary: "Get a note's latest graph proposal",
    description:
      'The newest proposal for this note that is not `discarded` (extracting, draft, failed, ' +
      'committed or reverted), or `{ proposal: null }`. Requires `graph:read`. **404**: no such ' +
      'note, deleted, or not yours.',
  })
  @ApiParam({ name: 'noteId', type: String, format: 'uuid' })
  @ApiDataResponse(NoteProposalResponseDto, { description: 'The latest proposal, or null' })
  @ApiResponse({ status: 404, description: 'No such note, deleted, or not yours' })
  async latestForNote(
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<NoteProposalResponse> {
    return this.proposals.latestForNote(user, noteId);
  }

  @Patch('proposals/:id/items/:itemId')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @ApiOperation({
    summary: 'Decide one proposal row',
    description:
      '`accept`, `edit` (with the full `editedPayload`, validated against your effective ' +
      'ontology — closed props; an entity may change type, which clears its link), `reject`, ' +
      '`pending`, or `merge_into` (entity rows: "this is the existing X", `mergeIntoId`). Also: ' +
      '`relinkTo` re-points one endpoint, `distinctFrom` sets candidates apart, `evidence.add` / ' +
      '`evidence.remove` edit the row\'s citations (an added span must match the current text). ' +
      'Nothing reaches your graph until the proposal is committed. Requires `graph:write`.\n\n' +
      '**400** `details.issues` for an invalid payload, relink or type; `details.reason`: ' +
      '`span_mismatch`, `span_outside_source`, `would_orphan`. **404**: proposal, row, entity or ' +
      'evidence not found. **409** `details.reason`: `proposal_not_draft`, `stale_note_version`, ' +
      '`stale_segment_rev`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'itemId', type: String, format: 'uuid' })
  @ApiBody({ type: PatchItemBodyDto })
  @ApiDataResponse(ItemDecisionResponseDto, { description: 'The row as it now reads, and the counts' })
  @ApiResponse({ status: 400, description: 'Invalid decision, payload, relink or span' })
  @ApiResponse({ status: 403, description: 'Your own proposal, without `graph:write`' })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @ApiResponse({ status: 409, description: '`proposal_not_draft`, `stale_note_version` or `stale_segment_rev`' })
  async decide(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body(new ZodValidationPipe(patchItemSchema)) body: PatchItemDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ItemDecisionResponse> {
    return this.proposals.decide(user, id, itemId, body);
  }

  @Post('proposals/:id/items/bulk')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decide many proposal rows',
    description:
      'Sets `accept`, `reject` or `pending` on up to 500 rows. A sensitive person fact and a ' +
      'closing are never accepted in bulk — they come back in `skipped` ' +
      '(`sensitive_requires_individual_accept`, `closing_requires_individual_accept`), as does an ' +
      'id that is not a row of this proposal (`not_found`). Requires `graph:write`. **404**: ' +
      NOT_FOUND + ' **409**: ' + NOT_DRAFT,
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: BulkDecisionBodyDto })
  @ApiDataResponse(BulkDecisionResponseDto, { description: 'How many rows changed, which were skipped, and the counts' })
  @ApiResponse({ status: 403, description: 'Your own proposal, without `graph:write`' })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @ApiResponse({ status: 409, description: NOT_DRAFT })
  async bulk(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(bulkDecisionSchema)) body: BulkDecisionDto,
    @CurrentUser() user: RequestUser,
  ): Promise<BulkDecisionResponse> {
    return this.proposals.bulk(user, id, body);
  }

  @Post('proposals/:id/items')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a missing row from a text selection',
    description:
      'Adds an entity, relation or item the extraction missed, cited by 1–10 spans you selected ' +
      'in the note (at its current version) or in a line of its source transcript (at the line\'s ' +
      'current `rev`). The server assigns the row\'s `ref` (`u1`, `u2`, …) and accepts it; ' +
      '`existingEntityId` (entities) says "this is the existing X" instead. Requires ' +
      '`graph:write`.\n\n**400**: an invalid payload (`details.issues`), `span_mismatch`, ' +
      '`span_outside_source`. **404**: proposal or `existingEntityId`. **409** ' +
      '`details.reason`: `proposal_not_draft`, `stale_note_version`, `stale_segment_rev`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: AddItemBodyDto })
  @ApiDataResponse(ItemDecisionResponseDto, { status: 201, description: 'The new row and the counts' })
  @ApiResponse({ status: 400, description: 'Invalid payload or span' })
  @ApiResponse({ status: 403, description: 'Your own proposal, without `graph:write`' })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @ApiResponse({ status: 409, description: '`proposal_not_draft`, `stale_note_version` or `stale_segment_rev`' })
  async addItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(addItemSchema)) body: AddItemDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ItemDecisionResponse> {
    return this.proposals.addItem(user, id, body);
  }

  @Post('proposals/:id/commit')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a proposal to your graph',
    description:
      'Commits every accepted, edited and merged row in **one transaction**: entities are ' +
      'created or linked, then relations, items and closings; every row that enters your graph ' +
      'carries at least one citation (the no-orphans rule — a violation rolls everything back ' +
      'with a 500). Rows still `pending` are not sent and not remembered as rejected. Requires ' +
      '`graph:write`.\n\n**400** `details.items: [{ itemId, issues }]` — any row that cannot be ' +
      'committed as it stands (an entity row it names is not accepted: `endpoint_not_accepted`; ' +
      'a merge target that is gone: `merge_target_gone`); nothing is written. **404**: ' +
      NOT_FOUND + ' **409**: ' + NOT_DRAFT,
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: EmptyProposalBodyDto })
  @ApiDataResponse(CommitResponseDto, { description: 'The committed proposal and what the commit did' })
  @ApiResponse({ status: 400, description: 'Rows that cannot be committed (`details.items`)' })
  @ApiResponse({ status: 403, description: 'Your own proposal, without `graph:write`' })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @ApiResponse({ status: 409, description: NOT_DRAFT })
  async commit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser,
  ): Promise<CommitResponse> {
    await EMPTY_PIPE.transform(body ?? {}, { type: 'body' });
    return this.commits.commit(user, id);
  }

  @Post('proposals/:id/discard')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Discard a proposal',
    description:
      'A `draft` or `failed` proposal becomes `discarded`; nothing reaches your graph. Requires ' +
      '`graph:write`. **404**: ' + NOT_FOUND + ' **409**: `proposal_not_draft` for any other status.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: EmptyProposalBodyDto })
  @ApiDataResponse(ProposalResponseDto, { description: 'The discarded proposal' })
  @ApiResponse({ status: 403, description: 'Your own proposal, without `graph:write`' })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @ApiResponse({ status: 409, description: '`proposal_not_draft`' })
  async discard(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser,
  ): Promise<ProposalResponse> {
    await EMPTY_PIPE.transform(body ?? {}, { type: 'body' });
    return this.proposals.discard(user, id);
  }

  @Post('proposals/:id/revert')
  @Auth({ permissions: [PERMISSIONS.GRAPH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revert a committed proposal',
    description:
      'Removes what the commit added and restores what it changed — but only rows untouched ' +
      'since. Anything edited, cited, referenced or merged since is **kept** and listed. With ' +
      'such rows and `confirmPartial: false` (the default) the answer is **409** ' +
      '`revert_conflict` with `details: { conflicts, revertible }` and nothing changes; send ' +
      '`confirmPartial: true` to revert the rest. Requires `graph:write`. **404**: ' + NOT_FOUND +
      ' **409** `details.reason`: `proposal_not_committed`, `revert_conflict`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: RevertBodyDto })
  @ApiDataResponse(RevertResponseDto, { description: 'The reverted proposal, what was reverted and what was kept' })
  @ApiResponse({ status: 403, description: 'Your own proposal, without `graph:write`' })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @ApiResponse({ status: 409, description: '`proposal_not_committed` or `revert_conflict`' })
  async revert(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser,
  ): Promise<RevertResponse> {
    const dto = (await REVERT_PIPE.transform(body ?? {}, { type: 'body' })) as RevertBody;
    return this.reverts.revert(user, id, dto.confirmPartial);
  }
}
