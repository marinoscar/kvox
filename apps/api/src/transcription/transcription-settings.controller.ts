import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { TranscriptionSettingsService } from './transcription-settings.service';
import {
  TestTranscriptionConnectionDto,
  TranscriptionConnectionTestDto,
  TranscriptionSettingsResponseDto,
  UpdateTranscriptionSettingsDto,
} from './dto/transcription-settings.dto';

// =============================================================================
// TranscriptionSettingsController (issue #23, epic #19)
// =============================================================================
//
// The HTTP surface behind `/admin/settings/transcription`. Four operations,
// gated exactly as the `ADMIN_SECTIONS` card declares:
//
//   GET    /api/transcription-settings                       system_settings:read
//   PUT    /api/transcription-settings                       system_settings:write
//   POST   /api/transcription-settings/test                  system_settings:write
//   DELETE /api/transcription-settings/credentials/:provider system_settings:write
//
// `system_settings:*` rather than a new `transcription_settings:*` pair,
// deliberately, and the reasoning is the one `email-settings.controller.ts`
// states: the permission set is SEEDED, so a new string means a migration plus
// a re-seed plus every existing Admin role being updated — for a page that is
// administering system configuration by any reading. It is also literally true
// here in a way it is only figuratively true for email: this page edits the
// `transcription` NAMESPACE OF THE `global` system_settings ROW, which
// `system-settings.controller.ts` already gates on exactly these strings. A
// separate permission would mean the same bytes were reachable under two
// different authorities.
//
// (Contrast `push:read`/`push:write`, which ARE a pair of their own. That split
// was justified by blast radius — rotating a VAPID key knocks every subscriber
// offline. Nothing here has that property: the destructive act is deleting an
// API key, which stops future jobs and destroys nothing already stored.)
//
// THE TEST ENDPOINT IS GATED ON WRITE, NOT READ. It is side-effecting — it
// spends a request against a third party using a credential — and `:read` is
// held by anyone who may look at settings. Looking is not probing.
//
// -----------------------------------------------------------------------------
// A SEPARATE CONTROLLER, NOT A ROUTE ON SystemSettingsController
// -----------------------------------------------------------------------------
//
// `DbBackupController` is the precedent: a namespace of the `global` row with
// enough of its own surface (a credential, a probe) to deserve its own tag, its
// own DTOs and its own place in the API reference. Writes still go through
// `SystemSettingsService.patchSettings`, so the merge, the validation, the
// unknown-key preservation and the version counter are the row's own — there is
// no second writer to this row in this module.
// =============================================================================

@ApiTags('Transcription')
@Controller('transcription-settings')
export class TranscriptionSettingsController {
  constructor(private readonly settings: TranscriptionSettingsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get transcription settings (Admin only)',
    description:
      'Returns the transcription configuration, a masked `keyStatuses` entry for every ' +
      'registered provider, and the provider catalogue (capabilities and form fields) the ' +
      'admin page renders itself from.\n\n' +
      '**No provider API key is returned by this or any other endpoint.** Keys are held in ' +
      'the encrypted credential store and are unreadable through the API by design; ' +
      '`keyStatuses[].hint` is a mask such as `••••a1b2`, never the value. Submitting ' +
      '`apiKey` empty on `PUT` preserves the stored key.',
  })
  @ApiResponse({
    status: 200,
    description: 'Transcription settings, masked key statuses and the provider catalogue',
    type: TranscriptionSettingsResponseDto,
  })
  async getSettings() {
    return this.settings.describeForAdmin();
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Update transcription settings (Admin only)',
    description:
      'Updates the transcription configuration. Every settings field is optional — send only ' +
      'what changed.\n\n' +
      '`apiKey` is **write-only**: send it to set or rotate the key for the provider being ' +
      'saved, and **omit it or send it empty to keep the stored one**. There is no way to ' +
      'erase a key through this endpoint — use ' +
      '`DELETE /api/transcription-settings/credentials/{provider}`.\n\n' +
      'Sending `apiKey` without a provider (neither in the body nor already stored) is a 400: ' +
      'keys are stored per provider, so there would be nowhere to put it.',
  })
  @ApiHeader({
    name: 'If-Match',
    description:
      'Expected `version` for optimistic concurrency. Use `0` to assert that nothing is ' +
      'stored yet. Omit to overwrite unconditionally.',
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: 'The updated settings, re-read from storage',
    type: TranscriptionSettingsResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error, or an API key with no provider' })
  @ApiResponse({ status: 409, description: 'Version conflict' })
  async updateSettings(
    @Body() dto: UpdateTranscriptionSettingsDto,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    // `Number.isInteger` rather than a bare `parseInt`, matching
    // `EmailSettingsController`: `parseInt('abc')` is NaN and `NaN !== version`
    // is always true, so a malformed header would turn every save into a 409
    // that no amount of reloading fixes. An unparseable `If-Match` is treated
    // as absent, matching the header's own documented semantics.
    const parsed = ifMatch !== undefined ? Number.parseInt(ifMatch, 10) : NaN;
    const expectedVersion = Number.isInteger(parsed) ? parsed : undefined;

    // `apiKey` is destructured off HERE as well as in the service. Belt and
    // braces: the service is what guarantees it never reaches the settings
    // patch, and this makes the guarantee visible at the boundary where a
    // reviewer is looking for it.
    const { apiKey, ...settings } = dto;

    return this.settings.update({ settings, apiKey }, userId, expectedVersion);
  }

  @Post('test')
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test a transcription provider credential (Admin only)',
    description:
      'Probes the provider with the supplied key, or with the stored key when none is ' +
      'supplied. **The supplied key does not need to have been saved** — proving a key ' +
      'before committing it is the workflow this endpoint exists for.\n\n' +
      '**This returns HTTP 200 even when the probe failed.** A refused probe is a successful ' +
      'diagnosis, and it is the reason this endpoint exists — read the `ok` field, and show ' +
      '`detail`, which distinguishes "the key is wrong or belongs to the other region", ' +
      '"the account is rate-limited" and "the endpoint was unreachable". Treating 200 as ' +
      '"the credential works" reports success for every misconfiguration there is.\n\n' +
      'A 400 means the request itself was unusable — an unknown provider, or no key supplied ' +
      'and none stored — which is a different thing from a failed probe.',
  })
  @ApiResponse({
    status: 200,
    description: 'The outcome of the probe. Check `ok`; on failure `detail` names the fix.',
    type: TranscriptionConnectionTestDto,
  })
  @ApiResponse({ status: 400, description: 'Unknown provider, or no key supplied and none stored' })
  async testConnection(
    @Body() dto: TestTranscriptionConnectionDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.settings.testConnection(
      { provider: dto.provider, region: dto.region, apiKey: dto.apiKey },
      userId,
    );
  }

  @Delete('credentials/:provider')
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a stored provider API key (Admin only)',
    description:
      'Erases the stored API key for one provider. This is the **only** way to remove a key — ' +
      'submitting an empty `apiKey` on `PUT` preserves the stored one, deliberately, because ' +
      'the form renders that box empty.\n\n' +
      'Idempotent: removing a key that is not there succeeds. **It does not change the ' +
      'settings** — removing the active provider\'s key leaves `enabled` and `provider` as ' +
      'they were, so a key rotation (delete, then paste the new one) is not an outage.',
  })
  @ApiParam({
    name: 'provider',
    description: 'The provider id whose key to erase, e.g. `assemblyai`.',
  })
  @ApiResponse({ status: 204, description: 'The key is gone (or was never there)' })
  @ApiResponse({ status: 400, description: 'Unknown provider' })
  async removeCredential(
    @Param('provider') provider: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.settings.removeCredential(provider, userId);
  }
}
