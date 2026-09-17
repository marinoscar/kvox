import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { OnboardingStateDto } from './dto/onboarding-state.dto';
import { OnboardingService } from './onboarding.service';

// =============================================================================
// `GET /api/onboarding` — the caller's own activation checklist (#275, epic #271)
// =============================================================================
//
// WHY THIS ROUTE CARRIES NO PERMISSION STRING
// --------------------------------------------
// The resource is the caller's own onboarding state, scoped by `userId` in the
// query itself — the identical ownership-scoped posture `/api/ai-credentials`,
// `/api/pat` and `/api/user-data` already take. It must also be readable by a
// plain Viewer, which is this application's DEFAULT role and therefore the role
// most likely to be looking at a getting-started page, and every candidate
// permission string is either seeded Admin-only or belongs to a different
// controller entirely.
//
// The per-step permission filtering that does happen reads the caller's own
// permission set off the request (`RequestUser.permissions`, already resolved
// by `JwtAuthGuard`) — it is about which DESTINATIONS to offer, not about
// whether this endpoint may be called.
//
// WHY IT IS A SEPARATE ROUTE FROM THE ADMIN ONE, ON A DIFFERENT PREFIX
// ---------------------------------------------------------------------
// The same split `/api/nodes` and `/api/admin/nodes` already make, for the same
// reason: the admin surface sits outside this one BY CONSTRUCTION rather than
// by a runtime check inside a shared handler. Concretely, it is what lets
// #274's context builders be two separate functions — so there is no code path
// on which a Viewer's request reads email settings, VAPID configuration, the
// backup schedule or the account counts, filtered out afterwards or otherwise.
//
// REJECTED — one route returning both lists with the admin half empty for
// non-admins. That is the partial-answer shape `HomePage.tsx`'s header already
// rejects for `GET /api/home/summary`, and it is worse here: an empty array is
// indistinguishable from "nothing left to do", so a Viewer would be shown a
// fully-configured deployment.
//
// REJECTED — one route with `?audience=`. The gate would then depend on a query
// string rather than on the route, which is precisely the property the
// two-prefix split exists to avoid.
// =============================================================================

@ApiTags('Onboarding')
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  @Auth()
  @ApiOperation({
    summary: 'The signed-in user’s activation checklist',
    description:
      'What this account still has to do to start using the application: add an AI provider key, ' +
      'transcribe something, generate a note, set a display name. Readable by **any authenticated ' +
      'user** — including one holding no permissions at all, which is what a freshly invited ' +
      'account looks like.\n\n' +
      '**Every status is derived on each read.** Nothing about completion is stored, so an ' +
      'administrator rotating a provider key away flips the relevant steps back on the next ' +
      'request, with nothing to clear.\n\n' +
      'A step is **absent** rather than disabled when the caller lacks the permission its ' +
      'destination enforces, or when it is irrelevant to this deployment — a deployment naming no ' +
      'AI vendor has no key for anyone to add, so `user.ai_key` is not returned at all.\n\n' +
      '`blocked` is distinct from `pending` on purpose: it means somebody else has to act first, ' +
      'and `blockedReason` names who. A user staring at a disabled upload button is told their ' +
      'administrator has not connected a provider, rather than being left to read it as their own ' +
      'unfinished to-do.\n\n' +
      'A step the caller has skipped is still returned, marked `skipped: true` and counted out of ' +
      'the two remaining-counts — filtering it out server-side would make the skip impossible to ' +
      'undo from the UI.',
  })
  @ApiResponse({
    status: 200,
    description: 'The caller’s activation steps, with derived statuses',
    type: OnboardingStateDto,
  })
  async getOnboarding(@CurrentUser() user: RequestUser): Promise<OnboardingStateDto> {
    return (await this.onboarding.getUserState(user)) as OnboardingStateDto;
  }
}
