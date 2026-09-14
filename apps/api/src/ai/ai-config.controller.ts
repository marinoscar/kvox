import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { AiConfigService } from './ai-config.service';
import { AiConfigDto, type AiConfigResponse } from './dto/ai-config.dto';

// =============================================================================
// AiConfigController (issue #47, epic #45)
// =============================================================================
//
// ONE ROUTE: what this deployment permits, and whether the CALLER has a key —
// for a client deciding whether to offer AI at all and, if so, whether to show
// the feature or the "set up your key" prompt.
//
// Modelled on `GET /api/transcription/config` and `GET
// /api/notifications/config`, which exist for the same reason and state the
// argument in full: the capability is governed by `system_settings:read`, which
// the seeded `viewer` and `contributor` roles do not hold — so the users the
// capability affects are precisely the users who cannot read it. Widening that
// permission to fix it would publish the entire settings blob to every account.
// A capability probe hands out the CAPABILITY, not the configuration behind it.
//
// GATED ON `notes:read` RATHER THAN LEFT MERELY AUTHENTICATED, following that
// same precedent and docs/specs/notes.md §6.4: `notes:read` is seeded to all
// three roles, so this stays readable by every ordinary account — the property
// the argument above depends on — while naming the permission the feature
// actually has rather than asserting "authenticated and nothing else".
//
// ⚠ `keyConfigured` IS THE SINGLE BOOLEAN THE ENTIRE WEB UI GATES ON (issue
// #47). It is per-CALLER, resolved without decrypting anything, and deliberately
// independent of `available` — see `ai-config.service.ts` for why.
//
// SO THIS RESPONSE CARRIES NO POLICY DETAIL BEYOND WHAT A CLIENT MUST ACT ON:
// not the base URL, not the request timeout, and nothing whatsoever derived
// from anyone's API key beyond the boolean fact that the caller has one.
//
// A SEPARATE CONTROLLER FROM THE SETTINGS ONE, on a different path prefix, so
// the two authorities are visibly different things rather than two decorators
// in one file that a later edit can confuse. `/api/ai/config` sits outside
// `/api/ai-settings` by construction.
// =============================================================================

@ApiTags('AI')
@Controller('ai')
export class AiConfigController {
  constructor(private readonly config: AiConfigService) {}

  @Get('config')
  // `notes:read`, seeded to all three roles (#48) — so this is readable by
  // every ordinary account, which is the property the header's argument
  // depends on, while naming the permission the feature actually has.
  @Auth({ permissions: [PERMISSIONS.NOTES_READ] })
  @ApiOperation({
    summary: 'AI capabilities of this deployment, for the calling user',
    description:
      'What this deployment permits and whether **you** have set up a key. Readable by any ' +
      'account holding `notes:read`, which is seeded to every role — the capability governs ' +
      'every account, so every account can read it.\n\n' +
      '`available` is true only when AI is enabled, the configured provider is registered in ' +
      'this build, at least one permitted model is one this build can budget requests for, ' +
      'and the token ceilings leave room for input. Anything less is a half-configured ' +
      'deployment, and reporting it as available moves the failure from a disabled control to ' +
      'a failed generation the user has already paid their own provider for.\n\n' +
      '⚠ `keyConfigured` is **the** field to gate the UI on: false means show the "set up ' +
      'your AI key" prompt, true means show the feature. It describes **you**, not the ' +
      'deployment, and it is independent of `available` — a user can save and verify a key ' +
      'before an administrator finishes enabling the feature, and an enabled deployment still ' +
      'does nothing for a user who has no key. There is deliberately no fallback key: AI in ' +
      'this application runs on each user\'s own provider account.\n\n' +
      '`models` and `defaultModel` are already narrowed by policy, so a client can offer them ' +
      'directly without re-checking. **No configuration detail is published here** — not the ' +
      'base URL, not the request timeout, and no part of any API key. Administrators read ' +
      '`GET /api/ai-settings` for those.',
  })
  @ApiResponse({
    status: 200,
    description: "This deployment's AI capabilities, and whether the caller has a key",
    type: AiConfigDto,
  })
  async getConfig(@CurrentUser('id') userId: string): Promise<AiConfigResponse> {
    return this.config.getConfig(userId);
  }
}
