import { Body, Controller, Get, Headers, Put } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { PERMISSIONS } from '../common/constants/roles.constants';
import { AiTasksConfigDto, AiTasksSettingsViewDto, UpdateAiTasksSettingsDto } from './dto/ai-tasks.dto';
import { AiTasksService } from './ai-tasks.service';

// =============================================================================
// AiTasksController (issue #473, epic #472)
// =============================================================================
//
// `/api/ai-tasks/*`, deliberately OUTSIDE `/api/ai/*`: that prefix belongs to the
// platform AI slice, whose rule is `AiEnabledGuard` + `ai:use` on every route.
// These three routes are this app's:
//
//   GET /api/ai-tasks/config    the capability probe the web reads, `notes:read`
//                               (seeded to every role, so the users the capability
//                               governs can read it). It replaced this app's
//                               `GET /api/ai/config`, whose path the platform owns.
//   GET /api/ai-tasks/settings  the admin view of the fields this app adds to the
//                               `ai` namespace, `ai_config:read`.
//   PUT /api/ai-tasks/settings  its write, `ai_config:write`.
// =============================================================================

@ApiTags('AI Tasks')
@Controller('ai-tasks')
export class AiTasksController {
  constructor(private readonly tasks: AiTasksService) {}

  @Get('config')
  @Auth({ permissions: [PERMISSIONS.NOTES_READ] })
  @ApiOperation({
    summary: 'AI task capabilities of this deployment, for the calling user',
    description:
      'What this deployment permits and whether **you** have saved a key. Readable by any ' +
      'account holding `notes:read`, which is seeded to every role.\n\n' +
      '`keyConfigured` is the field every AI surface gates on: false means show the "set up ' +
      'your AI key" prompt. It describes **you**, not the deployment, and is independent of ' +
      '`available`. `models` are the models an administrator enabled; `taskModels` is, for each ' +
      'connected-knowledge task, the model it would run on and whether it can. **No ' +
      'configuration detail is published here** and nothing derived from any key beyond the ' +
      'boolean fact that you have one.\n\n' +
      'This replaces `GET /api/ai/config`, which is now the platform AI slice\'s own probe.',
  })
  @ApiResponse({ status: 200, description: "This deployment's AI task capabilities", type: AiTasksConfigDto })
  async getConfig(@CurrentUser('id') userId: string) {
    return this.tasks.getConfig(userId);
  }

  @Get('settings')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_READ] })
  @ApiOperation({
    summary: 'Get the AI task settings (Admin only)',
    description:
      'The fields this application adds to the platform `ai` settings namespace: `taskModels`, ' +
      '`graphEnabled`, `defaultModel` and the request limits, with the task definitions, the ' +
      'enabled models and what each task would run on right now. `version` is the `If-Match` ' +
      'token of `PUT`. The provider slots, key policy and model catalogue are the platform\'s ' +
      '(`/api/admin/ai/*`).',
  })
  @ApiResponse({ status: 200, description: 'The AI task settings', type: AiTasksSettingsViewDto })
  async getSettings() {
    return this.tasks.describeForAdmin();
  }

  @Put('settings')
  @Auth({ permissions: [PERMISSIONS.AI_CONFIG_WRITE] })
  @ApiOperation({
    summary: 'Update the AI task settings (Admin only)',
    description:
      'Every field is optional; send only what changed. **`taskModels` replaces wholesale**: send ' +
      'the full map, `{}` clears it. Each task model present is checked against the enabled ' +
      'models: a model that is not enabled is a **400** with `details.reason: "model_not_permitted"` ' +
      'and `details.task`; one lacking a capability the task requires is a **400** with ' +
      '`details.reason: "model_lacks_capability"` and `details.missing`. **This endpoint never ' +
      'accepts an API key.**',
  })
  @ApiHeader({
    name: 'If-Match',
    description:
      'Expected `version` for optimistic concurrency. Use `0` to assert that nothing is stored yet. Omit to overwrite unconditionally.',
    required: false,
  })
  @ApiResponse({ status: 200, description: 'The updated settings, re-read from storage', type: AiTasksSettingsViewDto })
  @ApiResponse({ status: 400, description: 'Validation error or an invalid task model (`details.reason`)' })
  @ApiResponse({ status: 409, description: 'Version conflict' })
  async updateSettings(
    @Body() dto: UpdateAiTasksSettingsDto,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const parsed = ifMatch !== undefined ? Number.parseInt(ifMatch, 10) : NaN;
    const expectedVersion = Number.isInteger(parsed) ? parsed : undefined;

    return this.tasks.update(dto, userId, expectedVersion);
  }
}
