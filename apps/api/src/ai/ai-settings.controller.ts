import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { AiModelDiscoveryService } from './ai-model-discovery.service';
import { AiSettingsService } from './ai-settings.service';
import {
  AiModelDiscoveryDto,
  AiModelDiscoveryQueryDto,
} from './dto/ai-model-discovery.dto';
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
// The DEPLOYMENT-POLICY surface. Four operations, gated exactly as
// docs/specs/notes.md §6.4 requires:
//
//   GET  /api/ai-settings         system_settings:read
//   GET  /api/ai-settings/models  system_settings:write   (#78)
//   PUT  /api/ai-settings         system_settings:write
//   POST /api/ai-settings/test    system_settings:write
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
// THE TEST AND MODELS ENDPOINTS ARE GATED ON WRITE, NOT READ, even though one
// of them is a GET. Both are side-effecting — each spends an outbound request —
// and `:read` is held by anyone who may look at settings. Looking is not
// probing. `GET /api/ai-settings/models` additionally spends the CALLING
// ADMINISTRATOR'S OWN API key, because this deployment holds none; see
// `AiModelDiscoveryService`.
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
  constructor(
    private readonly settings: AiSettingsService,
    // A SECOND SERVICE ON ONE CONTROLLER, deliberately: model discovery has to
    // resolve the CALLER'S own credential, and a `discoverModels` method on
    // `AiSettingsService` would close a dependency cycle with
    // `UserAiCredentialsService` (which already injects the settings service)
    // and force a `forwardRef` on both. See `AiModelDiscoveryService`'s header.
    private readonly discovery: AiModelDiscoveryService,
  ) {}

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
      'never express "stop permitting this model".\n\n' +
      'An entry may be a **bare model id** (`"gpt-4o"`) or an **object** ' +
      '(`{ "id": "…", "label": "…", "contextWindowTokens": 200000, "maxOutputTokens": 32768 }`). ' +
      'Both forms are accepted for ever — every deployment that saved a policy before this ' +
      'existed has bare strings stored — and both are read back as objects. The numbers on an ' +
      'entry OVERRIDE this build\'s own catalogue, which is what lets a deployment permit a ' +
      'model no release of this application knows about yet.\n\n' +
      '**Since issue #97 the numbers are optional in practice, not just in the schema.** An ' +
      'entry that carries none is resolved from this build\'s catalogue, then from the family ' +
      'the id belongs to (`gpt-5.4-mini-2026-03-17` takes `gpt-5.4-mini`\'s window), then from ' +
      "a conservative floor the provider declares. `GET /api/ai/config` reports which of those " +
      'answered, per model, as `source`.\n\n' +
      'A **400** is therefore returned only for an entry **nothing** could budget for: no ' +
      'numbers on the entry and no provider knowledge of any kind, which in practice means the ' +
      'policy names a provider this build does not implement. The message names the missing ' +
      'fields — it is not a statement that the model is forbidden.\n\n' +
      '**`taskModels` (issue #360) also REPLACES wholesale** — send the full map. Each entry ' +
      'present is checked: a model outside the permitted list (after this same request\'s ' +
      '`allowedModels`, if any) is a **400** with `details.reason: "model_not_permitted"` and ' +
      '`details.task`; a model lacking a capability the task requires is a **400** with ' +
      '`details.reason: "model_lacks_capability"` and `details.missing`. Narrowing ' +
      '`allowedModels` under a stored task model is allowed: the task falls back to the default ' +
      'model and `taskModelStatus` reports it. `graphEnabled` switches connected-knowledge AI ' +
      'spending on or off.',
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
  @ApiResponse({
    status: 400,
    description:
      'Validation error, a model id nothing in this deployment can supply a context window for, or an invalid task model (`details.reason`: `model_not_permitted` / `model_lacks_capability`)',
  })
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

  @Get('models')
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: "List the provider's live models (Admin only)",
    description:
      "Asks the configured provider's own API which models are available, so the model policy " +
      'can be chosen from a list instead of typed from memory. This is what makes ' +
      '`allowedModels` independent of the four-model catalogue compiled into this build.\n\n' +
      '⚠ **It spends a real vendor call, on YOUR OWN API key.** This deployment stores no AI ' +
      'key of any kind — every key belongs to an individual user — so discovery has to ' +
      'authenticate as the administrator making the request. That is also why this route is ' +
      'gated on `system_settings:write` rather than `:read`: looking at settings is not ' +
      'probing a third party.\n\n' +
      'The list is the one **your** key can reach, which on OpenAI is project-scoped. Two ' +
      'administrators can legitimately see different lists; the policy you save is checked ' +
      "against neither, but against each user's own key at generation time.\n\n" +
      '**This returns HTTP 200 even when the provider refused.** Read `ok` and show `detail`, ' +
      'which distinguishes "the key is wrong", "the account has no credit" and "the endpoint ' +
      'is unreachable".\n\n' +
      '**Every model comes back with a context window and an output ceiling** (issue #97). ' +
      'They are detected automatically: verified numbers for a model this build knows, else ' +
      "the numbers of the family the id belongs to (`gpt-5.4-mini-2026-03-17` takes " +
      "`gpt-5.4-mini`'s), else a conservative floor for the provider. `source` says which, and " +
      '`derivedFrom` names the family. Nothing has to be typed to permit a model — an ' +
      'administrator may still override either number per model, which outranks all three.\n\n' +
      'The list is filtered to plausible chat models as a convenience; pass `includeAll=true` ' +
      "to get the provider's whole list when that heuristic has hidden something.",
  })
  @ApiQuery({
    name: 'provider',
    required: false,
    description:
      'Which provider to ask. Defaults to the active one, so an administrator can inspect a catalogue before switching to it.',
  })
  @ApiQuery({
    name: 'includeAll',
    required: false,
    enum: ['true', 'false'],
    description:
      "`true` returns every model the provider listed, skipping the plausible-chat-model filter (issue #97). The filter keeps embeddings, voices and moderation endpoints out of a model dropdown, but it is a heuristic over ids the vendor invents on its own schedule — this is the escape hatch that stops it ever being the reason a working model cannot be found.",
  })
  @ApiResponse({
    status: 200,
    description:
      'The model list, or — with `ok: false` — a diagnosis of why the provider would not give one.',
    type: AiModelDiscoveryDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'No provider is active and none was named, the named provider is not implemented by this build, it cannot list models at all, or its stored configuration is invalid.',
  })
  @ApiResponse({
    status: 409,
    description:
      '`details.reason: ai_key_missing` — **you** have saved no API key for that provider. There is no deployment key to fall back to; add yours and retry.',
  })
  async listProviderModels(
    @Query() query: AiModelDiscoveryQueryDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.discovery.discoverModels(
      userId,
      query.provider,
      query.includeAll,
    );
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
