import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { TranscriptionConfigService } from './transcription-config.service';
import {
  TranscriptionConfigDto,
  type TranscriptionConfigResponse,
} from './dto/transcription-settings.dto';

// =============================================================================
// TranscriptionConfigController (issue #23, epic #19)
// =============================================================================
//
// ONE ROUTE, readable by any authenticated user: what this deployment can
// transcribe, for a client deciding whether to offer the feature and what file
// to let a user pick.
//
// Modelled on `GET /api/notifications/config` (#226), which exists for exactly
// the same reason and states the argument in full in
// `notifications/dto/notification-config.dto.ts`: the capability is governed by
// `system_settings:read`, which the seeded `viewer` and `contributor` roles do
// not hold, so the users the capability affects are precisely the users who
// cannot read it. Widening that permission to fix it would publish the entire
// settings blob to every account. A capability probe hands out the CAPABILITY,
// not the configuration behind it.
//
// SO THIS RESPONSE CARRIES NO POLICY DETAIL: not the region, not the model, not
// the delivery mode, not `deleteRemoteAfterIngest`, and — needless to say —
// nothing derived from the API key beyond the boolean fact that one exists. See
// `transcriptionConfigSchema`.
//
// A SEPARATE CONTROLLER FROM THE SETTINGS ONE, on a different path prefix, so
// the two authorities are visibly different things rather than two decorators
// in one file that a later edit can confuse. `/api/transcription/config` sits
// outside `/api/transcription-settings` by construction.
// =============================================================================

@ApiTags('Transcription')
@Controller('transcription')
export class TranscriptionConfigController {
  constructor(private readonly config: TranscriptionConfigService) {}

  @Get('config')
  // `transcripts:read`, seeded to all three roles (#24) — so this is still
  // readable by every ordinary account, which is the property the header's
  // argument depends on, while naming the permission the feature actually has
  // rather than "authenticated and nothing else".
  @Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })
  @ApiOperation({
    summary: 'Transcription capabilities of this deployment',
    description:
      'What this deployment can transcribe, for a client deciding whether to offer the ' +
      'feature. Readable by **any authenticated user** — the capability governs every ' +
      'account, so every account can read it.\n\n' +
      '`available` is true only when transcription is enabled, a provider is chosen, that ' +
      'provider is registered in this build, **and** an API key is stored for it. Anything ' +
      'less is a half-configured deployment, and reporting it as available moves the failure ' +
      'from a disabled button to a failed job minutes later.\n\n' +
      '`maxUploadBytes`, `maxDurationMs`, `acceptedExtensions` and `acceptedMimeTypes` ' +
      'describe the ACTIVE provider and are still reported when a provider is chosen but has ' +
      'no key — so a disabled control can still say what it would allow. They are zero and ' +
      'empty when no provider is chosen at all.\n\n' +
      '`keytermsSupported` and `maxKeyterms` (#327) say whether the active provider accepts ' +
      'expected names and terms at upload, and how many `POST /api/transcripts` will forward ' +
      '(the smaller of this API\'s limit of 200 and the provider\'s). `false`/`0` when ' +
      'unsupported or no provider is chosen.\n\n' +
      '**No configuration detail is published here** — not the region, not the model, not ' +
      'the delivery mode, and no part of the API key. Administrators read ' +
      '`GET /api/transcription-settings` for those.',
  })
  @ApiResponse({
    status: 200,
    description: "This deployment's transcription capabilities",
    type: TranscriptionConfigDto,
  })
  async getConfig(): Promise<TranscriptionConfigResponse> {
    return this.config.getConfig();
  }
}
