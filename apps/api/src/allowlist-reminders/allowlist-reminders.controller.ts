import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { AllowlistRemindersService } from './allowlist-reminders.service';
import {
  AllowlistReminderDto,
  AllowlistReminderQueryDto,
  AllowlistReminderRowDto,
} from './dto/allowlist-reminder.dto';

/**
 * app-owned routes beside the platform's `/api/allowlist` (list, add, remove).
 * The paths do not collide with the platform's: `GET /allowlist` and
 * `DELETE /allowlist/:id` there, `GET /allowlist/reminders` and
 * `POST /allowlist/:id/reminder` here.
 */
@ApiTags('Allowlist')
@Controller('allowlist')
export class AllowlistRemindersController {
  constructor(private readonly reminders: AllowlistRemindersService) {}

  @Get('reminders')
  @Auth({ permissions: [PERMISSIONS.ALLOWLIST_READ] })
  @ApiOperation({
    summary: 'Invitation reminder state for allowlist entries (Admin only)',
    description:
      'Returns `{ allowedEmailId, reminderCount, lastReminderAt }` for each requested entry that has ' +
      'been reminded at least once; entries never reminded are absent. `ids` is a comma-separated ' +
      'list of allowlist entry ids (at most 200). Counts mean a reminder was requested and handed to ' +
      'the notification dispatcher, not that mail arrived. Rows whose entry no longer exists are ' +
      'deleted first, with one bounded statement.',
  })
  @ApiDataResponse(AllowlistReminderRowDto, {
    isArray: true,
    description: 'Reminder state per reminded entry',
  })
  async list(@Query() query: AllowlistReminderQueryDto) {
    return this.reminders.list(query.ids.split(','));
  }

  @Post(':id/reminder')
  @Auth({ permissions: [PERMISSIONS.ALLOWLIST_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send an invitation reminder (Admin only)',
    description:
      'Emails the invitee again about an invitation they have not yet used, and records that a ' +
      'reminder was requested. Manual only: an administrator presses this, nothing schedules it. ' +
      'The recorded count and timestamp mean a reminder was requested and handed to the ' +
      'notification dispatcher; delivery itself is recorded per attempt in the notification ' +
      'delivery log, not here.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(AllowlistReminderDto, {
    status: 200,
    description: 'Reminder requested; the updated count',
  })
  @ApiResponse({ status: 404, description: 'Allowlist entry not found' })
  @ApiResponse({
    status: 409,
    description:
      'Entry is already claimed, there is nobody left to remind (`details.reason: already_claimed`)',
  })
  async sendReminder(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') adminUserId: string,
  ) {
    return this.reminders.sendReminder(id, adminUserId);
  }
}
