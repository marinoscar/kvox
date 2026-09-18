import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { OnboardingStateDto } from './dto/onboarding-state.dto';
import { OnboardingService, type OnboardingCaller } from './onboarding.service';

// =============================================================================
// `GET /api/admin/onboarding` — this deployment's setup checklist (#275, #271)
// =============================================================================
//
// WHY THIS REUSES `system_settings:read` RATHER THAN INVENTING `onboarding:read`
// ------------------------------------------------------------------------------
// Epic #118 decision 8 set the precedent when the About card was gated on
// `system_settings:read` with deliberately no `about:read`: "what is deployed
// here, and is it finished" is an ADMINISTRATOR'S CONFIGURATION READ, not a new
// authority. Every fact this route reports is one the holder of that permission
// can already read directly — the transcription settings, the AI policy, the
// email and push configuration, the backup schedule — so a new string would
// grant nothing and withhold nothing.
//
// It would not be free, either. A seeded permission that no controller uniquely
// enforces has to be added to the seed, to `apps/web/visual/main.tsx`'s
// `DEFAULT_PERMISSIONS` and to `mockAdminUser` in `test-utils.tsx` — three edits
// and a role migration, in exchange for a gate that is a synonym for one that
// already exists.
//
// WHY IT IS A SEPARATE CONTROLLER ON A SEPARATE PREFIX
// -----------------------------------------------------
// See `onboarding.controller.ts`'s header. The short version: the split is what
// makes "an admin-only fact is never computed on a Viewer's request" a
// structural property rather than a promise — `OnboardingService
// .buildAdminContext` has exactly one caller and it is behind this gate.
//
// DELIBERATELY NOT `@AllowDuringMaintenance()`, matching `AboutController`: this
// is an admin page, and an administrator already bypasses the window unless
// `allowAdmins` is false — in which case nothing but the maintenance switch
// itself should be answering.
//
// No audit event: this is a read, and it writes nothing at all.
// =============================================================================

@ApiTags('Onboarding')
@Controller('admin/onboarding')
export class AdminOnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'This deployment’s setup checklist',
    description:
      'What still has to be configured before this deployment is usable: a transcription ' +
      'provider, an AI policy, somebody invited, outbound email, browser notifications and a ' +
      'backup schedule — plus one step that is not a form at all.\n\n' +
      '**The list ends with a real transcription.** `admin.smoke_test` is satisfied only once ' +
      'this administrator owns a transcript that actually reached `ready`; it is the only step ' +
      'that proves the keys the earlier steps saved work together. A key can be well-formed, ' +
      'accepted and still wrong.\n\n' +
      '**Every status is derived on each read**, never stored — rotating a provider key away ' +
      'flips the step back on the next request rather than leaving a green tick over a ' +
      'deployment that can no longer transcribe.\n\n' +
      '`blocked` means another step has to land first and `blockedReason` says which: ' +
      '`admin.smoke_test` is blocked, not pending, while no transcription provider is connected.\n\n' +
      'Gated on `system_settings:read` — an administrator’s configuration read, deliberately not ' +
      'a permission of its own (epic #118 decision 8’s precedent, the same one the About card ' +
      'follows).',
  })
  @ApiResponse({
    status: 200,
    description: 'The deployment’s setup steps, with derived statuses',
    type: OnboardingStateDto,
  })
  async getAdminOnboarding(
    @CurrentUser() user: OnboardingCaller,
  ): Promise<OnboardingStateDto> {
    return (await this.onboarding.getAdminState(user)) as OnboardingStateDto;
  }
}
