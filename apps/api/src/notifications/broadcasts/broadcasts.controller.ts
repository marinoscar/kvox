// =============================================================================
// The broadcast admin routes (issue #324, epic #319)
// =============================================================================
//
// Seven routes at `/api/admin/broadcasts`. The controller binds, documents and
// authorizes; every decision about what a request means lives in
// `broadcasts.service.ts`, and everything about how a broadcast is actually
// DELIVERED lives one layer further out in the two job handlers.
//
// MOUNTED UNDER `/admin`, NOT ON `NotificationsController`. Every route on
// that controller is `@Auth()`-only and scoped to the token bearer's OWN
// notifications; these seven are admin-only and act on everybody's. One
// controller enforcing two entirely different authorization models is how a
// route ends up with the wrong one.
//
// -----------------------------------------------------------------------------
// ⚠ LITERAL ROUTES ARE DECLARED BEFORE `:id`, AND THE ORDER IS LOAD-BEARING
// -----------------------------------------------------------------------------
//
// Nest matches routes in DECLARATION ORDER, not by specificity — the same
// constraint `job-admin.controller.ts`'s header documents at length, and the
// same failure mode. Move `@Get(':id')` above `@Get('audience')` and
// `GET /api/admin/broadcasts/audience` is answered by `ParseUUIDPipe` with a
// 400 about a malformed UUID; move `@Post(':id/cancel')`-style parameterised
// routes above `@Post('test')` and a test send becomes unreachable. There is
// no boot error and no log line for either — an admin just gets a nonsense
// 400, or worse, a 404 for a broadcast whose id is the literal text "test".
//
// The declaration order below is therefore: `audience`, `test`, `/` (GET),
// `/` (POST), then `:id`, `:id/cancel` and `DELETE :id`. Keep every literal
// above every parameterised route — `test/broadcasts/broadcasts.integration.spec.ts`
// drives both literals through the real router precisely so that re-ordering
// these methods fails a test rather than causing a production incident.
//
// -----------------------------------------------------------------------------
// TWO PERMISSIONS, SPLIT ON READ VERSUS WRITE
// -----------------------------------------------------------------------------
//
// `broadcasts:read` for `audience`, the list and the detail; `broadcasts:write`
// for create, test, cancel and delete. Both seeded to ADMIN ONLY (#320), and
// `@Auth({ roles: [ROLES.ADMIN], permissions: [...] })` states both — the role
// admits, the permission is what the guard checks. The pair is what a settings
// card's `permission` field must mirror byte-for-byte (CLAUDE.md, Settings UI
// Pattern rule 3), so these strings are the API's half of that contract.
//
// The split earns its keep here more than anywhere else in this API: reading
// this surface shows what has been announced, while writing it sends a message
// to every active user — the highest-consequence action the application has.
// =============================================================================

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS, ROLES } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { BROADCAST_CHUNK_SIZE } from './broadcast-audience';
import { BroadcastsService } from './broadcasts.service';
import { BroadcastListQueryDto } from './dto/broadcast-list-query.dto';
import {
  BROADCAST_STATUSES,
  BroadcastAudienceDto,
  BroadcastCreateResultDto,
  BroadcastDetailDto,
  BroadcastDto,
  BroadcastTestResultDto,
} from './dto/broadcast-response.dto';
import { CreateBroadcastDto, TestBroadcastDto } from './dto/create-broadcast.dto';

@ApiTags('Notification Broadcasts')
@Controller('admin/broadcasts')
export class BroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  // -------------------------------------------------------------------------
  // Literal routes. These MUST stay above `:id` — see the file header.
  // -------------------------------------------------------------------------

  @Get('audience')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_READ] })
  @ApiOperation({
    summary: 'Count the users a broadcast would reach',
    description:
      'How many active users a broadcast created right now would target, counted with the same ' +
      'audience predicate the fan-out itself pages with — so the number shown in the composer ' +
      'and the confirmation dialog cannot disagree with the number the send later reports. It ' +
      'is an estimate for a SCHEDULED broadcast: the real audience is frozen at a cutoff ' +
      'stamped when sending begins, so users created or deactivated in between change it.',
  })
  @ApiResponse({ status: 200, description: 'Current audience size', type: BroadcastAudienceDto })
  async audience(): Promise<unknown> {
    return this.broadcasts.audience();
  }

  @Post('test')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send this composition to yourself',
    description:
      'Dispatches the composition to the CALLING USER ONLY, over the channels selected, using ' +
      'the same event key, the same payload and the same templates a real send would use. ' +
      'Writes no broadcast row and queues no job, so nothing appears in the list and nobody ' +
      'else is contacted. There is no recipient parameter by design — an endpoint that could ' +
      'send arbitrary admin-composed content to an arbitrary address would be a spam relay. ' +
      'A 200 means the dispatch was attempted, not that every channel succeeded: per-channel ' +
      'outcomes are recorded as delivery rows, exactly as they are for a real send.',
  })
  @ApiResponse({ status: 200, description: 'What was dispatched', type: BroadcastTestResultDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async test(
    @Body() dto: TestBroadcastDto,
    @CurrentUser('id') adminUserId: string
  ): Promise<unknown> {
    return this.broadcasts.sendTest(dto, adminUserId);
  }

  @Get()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_READ] })
  @ApiOperation({
    summary: 'List broadcasts',
    description:
      'Newest first, paginated, optionally filtered by lifecycle status. Includes the composed ' +
      'title and body, the channels chosen, the schedule, and the progress counters ' +
      '(`recipientsTargeted` and `recipientsDispatched`) the fan-out maintains.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Max 100.' })
  @ApiQuery({ name: 'status', required: false, enum: BROADCAST_STATUSES })
  @ApiDataResponse(BroadcastDto, { pagination: 'flat', description: 'Paginated broadcast list' })
  async list(@Query() query: BroadcastListQueryDto): Promise<unknown> {
    return this.broadcasts.list(query);
  }

  @Post()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_WRITE] })
  @ApiOperation({
    summary: 'Create and queue a broadcast',
    description:
      'Records the broadcast as `scheduled` and enqueues its fan-out. Omit `scheduledFor` to ' +
      'send immediately; supply a future timestamp to schedule it — the queued job is simply ' +
      'not claimable until then, so a scheduled broadcast survives every restart between now ' +
      'and its send time. The event key is DERIVED from `critical` and is never accepted from ' +
      'the client. A critical broadcast must include the `browser` channel: the durable in-app ' +
      'notification is the only record a recipient can go back and read. ' +
      'Returns the row plus a non-fatal `warnings` array — in particular, selecting `browser` ' +
      'while browser notifications are disabled deployment-wide is a warning, not an error, ' +
      'because scheduling an announcement for after that switch is flipped back is legitimate.',
  })
  @ApiResponse({ status: 201, description: 'The queued broadcast', type: BroadcastCreateResultDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async create(
    @Body() dto: CreateBroadcastDto,
    @CurrentUser('id') adminUserId: string
  ): Promise<unknown> {
    return this.broadcasts.create(dto, adminUserId);
  }

  // -------------------------------------------------------------------------
  // Parameterised routes. Nothing literal may be declared below this line.
  // -------------------------------------------------------------------------

  @Get(':id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_READ] })
  @ApiOperation({
    summary: 'Get one broadcast',
    description:
      'The full row plus `approximateDeliveryAttempts`, a per-channel/per-status breakdown of ' +
      'delivery rows recorded WHILE THIS BROADCAST WAS SENDING. It is APPROXIMATE and is named ' +
      'so: delivery rows carry no broadcast id, so attribution is by event key and time window ' +
      '(`startedAt` to `finishedAt`, or now). A second broadcast raised under the same event ' +
      'key during this one\'s send contributes to the total, and nothing here can separate ' +
      'them. Empty for a broadcast that has not started.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The broadcast', type: BroadcastDetailDto })
  @ApiResponse({ status: 404, description: 'Broadcast not found' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.broadcasts.get(id);
  }

  @Post(':id/cancel')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a scheduled or in-flight broadcast',
    description:
      'The only recall mechanism this feature has. Accepted for a `scheduled` or `sending` ' +
      'broadcast and refused with 409 for any other status. Applied as a conditional write, so ' +
      'it races the fan-out\'s own claim inside the database where exactly one of them can win.\n\n' +
      '⚠ CANCELLING A BROADCAST THAT IS ALREADY `sending` MAY STILL LET ONE IN-FLIGHT BATCH GO ' +
      'OUT: the fan-out re-checks the status between batches, so up to one chunk\'s worth of ' +
      `recipients (BROADCAST_CHUNK_SIZE, currently ${BROADCAST_CHUNK_SIZE}) can already have ` +
      'been dispatched or be ' +
      'mid-dispatch when the cancel lands. Cancel stops everything after that point; it cannot ' +
      'recall what has already been sent.\n\n' +
      'The row is kept, not deleted — a pulled announcement is exactly what an operator needs ' +
      'to look up later. Queued job rows are also left alone: deleting them would race a ' +
      'worker claiming one, the handlers\' status checks are the durable gate, and the rows are ' +
      'the audit history of what the fan-out actually did.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The cancelled broadcast', type: BroadcastDto })
  @ApiResponse({ status: 404, description: 'Broadcast not found' })
  @ApiResponse({ status: 409, description: 'The broadcast is not scheduled or sending' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') adminUserId: string
  ): Promise<unknown> {
    return this.broadcasts.cancel(id, adminUserId);
  }

  @Delete(':id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BROADCASTS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a broadcast',
    description:
      'Removes the record. Refused with 409 while the broadcast is `sending`: deleting the row ' +
      'would not stop the fan-out, which would then keep running against a record that no ' +
      'longer exists. Cancel it first. A `scheduled`, `sent`, `canceled` or `failed` broadcast ' +
      'can be deleted; a queued start job for a deleted broadcast is a harmless no-op when it ' +
      'is eventually claimed.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Broadcast deleted' })
  @ApiResponse({ status: 404, description: 'Broadcast not found' })
  @ApiResponse({ status: 409, description: 'The broadcast is currently sending' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') adminUserId: string
  ): Promise<void> {
    await this.broadcasts.remove(id, adminUserId);
  }
}
