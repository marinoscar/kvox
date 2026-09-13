import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Put,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { EmailSettingsService } from './email-settings.service';
import { EmailTestSendService } from './email-test-send.service';
import { EmailSettingsResponseDto } from './dto/email-settings-response.dto';
import { TestEmailResultDto } from './dto/test-email-result.dto';
import { UpdateEmailSettingsDto } from './dto/update-email-settings.dto';

// =============================================================================
// EmailSettingsController (issue #124, epic #109)
// =============================================================================
//
// The HTTP surface behind `/admin/settings/email`. Three operations, gated as
// the `ADMIN_SECTIONS` card declares:
//
//   GET  /api/email-settings        system_settings:read
//   PUT  /api/email-settings        system_settings:write
//   POST /api/email-settings/test   system_settings:write
//
// `system_settings:*` rather than a new `email_settings:*` pair, deliberately.
// The permission set is seeded (see prisma/seed.ts) and a new string means a
// migration plus a re-seed plus every existing Admin role being updated, for a
// page that is administering system configuration by any reading. #124 does
// not propose one, and the registry card mirrors the same strings.
//
// The TEST endpoint is gated on WRITE, not read. It is a side-effecting
// operation that causes the system to originate mail; `:read` is held by
// anyone who may look at settings, and looking is not sending.
//
// -----------------------------------------------------------------------------
// A SEPARATE CONTROLLER, NOT A ROUTE ON SystemSettingsController
// -----------------------------------------------------------------------------
//
// Same reasoning as the separate `system_settings` row (see
// email-settings.service.ts): the two surfaces write different rows and must
// not be able to clobber each other, and SMTP host/username stay out of
// `GET /api/system-settings`' response for free. It also keeps the OpenAPI tag
// -- and therefore the API reference -- split the way the settings pages are.
//
// NOTE THE MODULE THIS LIVES IN. `EmailModule` had no controller until now, on
// the grounds that adding an HTTP surface before there is something to expose
// puts a route to review in infrastructure. There is now something to expose,
// and it is reviewed here, in the diff that adds it.
// =============================================================================

@ApiTags('Email Settings')
@Controller('email-settings')
export class EmailSettingsController {
  constructor(
    private readonly emailSettings: EmailSettingsService,
    private readonly testSend: EmailTestSendService,
  ) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get email settings (Admin only)',
    description:
      'Returns the email configuration together with `smtpPasswordStatus`, a masked, ' +
      'non-secret description of the stored SMTP password. **The password itself is ' +
      'never returned by this or any other endpoint** — it is held in the encrypted ' +
      'credential store and is unreadable through the API by design. Submitting the ' +
      'password field empty on `PUT` preserves the stored value.',
  })
  @ApiResponse({
    status: 200,
    description: 'Email settings and stored-password status',
    type: EmailSettingsResponseDto,
  })
  async getSettings() {
    return this.emailSettings.describeForAdmin();
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Replace email settings (Admin only)',
    description:
      'Replaces the email configuration. `smtpPassword` is **write-only**: send it to ' +
      'set or rotate the SMTP password, and **omit it or send it empty to keep the ' +
      'stored one**. There is no way to erase a stored password through this endpoint.',
  })
  @ApiHeader({
    name: 'If-Match',
    description:
      'Expected `version` for optimistic concurrency. Use `0` to assert that nothing ' +
      'is stored yet. Omit to overwrite unconditionally.',
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: 'Updated email settings',
    type: EmailSettingsResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 409, description: 'Version conflict' })
  async replaceSettings(
    @Body() dto: UpdateEmailSettingsDto,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    // `Number.isInteger` rather than a bare `parseInt`: `parseInt('abc')` is
    // NaN, and `NaN !== currentVersion` is always true, so a malformed header
    // would turn every save into a 409 that no amount of reloading fixes. An
    // unparseable If-Match is treated as absent instead, matching the
    // header's own "omit to overwrite unconditionally" semantics.
    const parsed = ifMatch !== undefined ? Number.parseInt(ifMatch, 10) : NaN;
    const expectedVersion = Number.isInteger(parsed) ? parsed : undefined;

    return this.emailSettings.update(dto, userId, expectedVersion);
  }

  @Post('test')
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a test email to yourself (Admin only)',
    description:
      'Sends the test message through the configured provider **to the authenticated ' +
      "caller's own address**. There is no recipient parameter: a free-text recipient " +
      'would make this a send-arbitrary-mail endpoint.\n\n' +
      '**This returns HTTP 200 even when the send failed.** A refused send is a ' +
      'successful diagnosis, and it is the reason this endpoint exists — read the ' +
      '`success` field, and show `error`, which carries the provider’s actual message ' +
      '(`MessageRejected: Email address is not verified`, `535 Authentication failed`) ' +
      'with any credential redacted. Treating 200 as “email works” reports success for ' +
      'every misconfiguration there is.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The outcome of the attempt. Check `success`; on failure `error` holds the ' +
      "provider's verbatim message.",
    type: TestEmailResultDto,
  })
  async sendTestEmail(@CurrentUser() user: RequestUser) {
    // The recipient is the session's own address. Nothing from the request
    // body reaches the transport — there is no body, and no parameter for one.
    return this.testSend.sendTest({ id: user.id, email: user.email });
  }
}
