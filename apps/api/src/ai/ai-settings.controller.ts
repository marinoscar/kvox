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
import { PERMISSIONS } from '../common/constants/roles.constants';
import { AiSettingsService } from './ai-settings.service';
import {
  AiReachabilityTestDto,
  AiSettingsResponseDto,
  TestAiReachabilityDto,
  UpdateAiSettingsDto,
} from './dto/ai-settings.dto';

// =============================================================================
// AiSettingsController (issue #47, epic #45)
// =============================================================================
//
// The DEPLOYMENT-POLICY surface. Three operations, gated exactly as
// docs/specs/notes.md §6.4 requires:
//
//   GET  /api/ai-settings       system_settings:read
//   PUT  /api/ai-settings       system_settings:write
//   POST /api/ai-settings/test  system_settings:write
//
// `system_settings:*` rather than a new `ai:*` pair, and §6.4 checks that
// against the same four-way test CLAUDE.md applies to `push:*`, `nodes:*`,
// `broadcasts:*` and `db_backup:restore`: changing a policy value here disrupts
// nothing already in flight (unlike rotating a VAPID key), names no
// fleet-versus-queue distinction, sends nothing to anyone, and touches no data
// more consequential than an ordinary settings edit. It is also literally true
// that this page edits the `ai` NAMESPACE OF THE `global` system_settings ROW,
// which `system-settings.controller.ts` already gates on exactly these strings
// — a separate permission would mean the same bytes were reachable under two
// different authorities.
//
// ⚠ NOTHING HERE TOUCHES A CREDENTIAL, AND THERE IS NO ADMIN PATH TO ONE.
// Epic #45 is strict BYO: every AI key belongs to an individual user
// (`/api/ai-credentials`, gated by ordinary self-service ownership). An
// administrator configuring this page can see which providers and models are
// permitted — a setting, not a content fact — and has no route, through any
// permission this RBAC model grants, to any user's key or to anything generated
// with it. docs/specs/notes.md §9 states that in full; it is the same
// "configuring the pipe is not the authority to read what flows through it"
// posture transcription already takes, with the credential moved further out of
// reach.
//
// THE TEST ENDPOINT IS GATED ON WRITE, NOT READ. It is side-effecting — it
// spends an outbound request — and `:read` is held by anyone who may look at
// settings. Looking is not probing.
//
// A SEPARATE CONTROLLER, NOT A ROUTE ON SystemSettingsController, for the
// reason `TranscriptionSettingsController` states: a namespace of the `global`
// row with enough of its own surface to deserve its own tag, its own DTOs and
// its own place in the API reference. Writes still go through
// `SystemSettingsService.patchSettings`, so the merge, the validation, the
// unknown-key preservation and the version counter are the row's own.
// =============================================================================

@ApiTags('AI')
@Controller('ai-settings')
export class AiSettingsController {
  constructor(private readonly settings: AiSettingsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get the AI policy (Admin only)',
    description:
      'Returns the deployment AI policy and the provider catalogue (models and form fields) ' +
      'the admin page renders itself from.\n\n' +
      '**No API key is returned by this or any other endpoint, and this deployment stores ' +
      'none.** AI keys in this application are per-user: each user saves their own through ' +
      '`PUT /api/ai-credentials`, encrypted at rest and unreadable through the API by design. ' +
      'There is deliberately no deployment-wide fallback key — a user with no key has no AI ' +
      'features, and the product says so rather than spending the organisation\'s account on ' +
      'their behalf.\n\n' +
      '`unknownModels` lists model ids the policy permits that no registered provider ' +
      'declares. Such a model cannot be budgeted, so it is never offered to a user — this is ' +
      'where a mistyped model id becomes visible.',
  })
  @ApiResponse({
    status: 200,
    description: 'The AI policy and the provider catalogue',
    type: AiSettingsResponseDto,
  })
  async getSettings() {
    return this.settings.describeForAdmin();
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Update the AI policy (Admin only)',
    description:
      'Updates the AI policy. Every field is optional — send only what changed.\n\n' +
      '**This endpoint never accepts an API key.** There is no field for one, and there is no ' +
      'deployment key in this application; keys are per-user and are written through ' +
      '`PUT /api/ai-credentials` by their owner.\n\n' +
      '`allowedModels` REPLACES the stored list wholesale rather than merging — that is RFC ' +
      '7396\'s rule for arrays and the only workable one here, since a merging list could ' +
      'never express "stop permitting this model". A model id no registered provider declares ' +
      'is a 400 naming the ids this build can budget for.',
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
    description: 'The updated policy, re-read from storage',
    type: AiSettingsResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error, or an unknown model id' })
  @ApiResponse({ status: 409, description: 'Version conflict' })
  async updateSettings(
    @Body() dto: UpdateAiSettingsDto,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    // `Number.isInteger` rather than a bare `parseInt`, matching
    // `TranscriptionSettingsController` and `EmailSettingsController`:
    // `parseInt('abc')` is NaN and `NaN !== version` is always true, so a
    // malformed header would turn every save into a 409 that no amount of
    // reloading fixes. An unparseable `If-Match` is treated as absent, matching
    // the header's own documented semantics.
    const parsed = ifMatch !== undefined ? Number.parseInt(ifMatch, 10) : NaN;
    const expectedVersion = Number.isInteger(parsed) ? parsed : undefined;

    return this.settings.update(dto, userId, expectedVersion);
  }

  @Post('test')
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Probe the configured AI endpoint (Admin only)',
    description:
      'Checks that the configured API base URL resolves, terminates TLS and answers like an ' +
      'OpenAI-compatible API. Supply `baseUrl` to probe a URL **before** saving it.\n\n' +
      '⚠ **This is a reachability probe, not a credential probe** — it sends no key, because ' +
      'this deployment holds none. Users prove their own keys with ' +
      '`POST /api/ai-credentials/test`.\n\n' +
      '⚠ **An HTTP 401 or 403 from the endpoint is reported as `ok: true`.** An ' +
      'unauthenticated request to a correctly configured API root is *supposed* to be ' +
      'refused, and that refusal is the proof the endpoint exists and speaks the protocol. ' +
      'Treating it as a failure would make a correctly configured deployment look broken.\n\n' +
      '**This returns HTTP 200 even when the probe failed.** Read the `ok` field and show ' +
      '`detail`, which distinguishes "unreachable", "wrong path" and "answering normally".',
  })
  @ApiResponse({
    status: 200,
    description: 'The outcome of the probe. Check `ok`; on failure `detail` names the fix.',
    type: AiReachabilityTestDto,
  })
  async testReachability(
    @Body() dto: TestAiReachabilityDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.settings.testReachability(userId, dto.baseUrl);
  }
}
