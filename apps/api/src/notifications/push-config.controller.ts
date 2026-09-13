import {
  Body,
  Controller,
  Delete,
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
import { PushConfigService } from './push-config.service';
import { GeneratePushConfigDto } from './dto/generate-push-config.dto';
import { PushConfigResponseDto } from './dto/push-config-response.dto';
import {
  RemovePushConfigDto,
  RotatePushConfigDto,
} from './dto/push-config-confirmation.dto';
import { UpdatePushConfigDto } from './dto/update-push-config.dto';

// =============================================================================
// PushConfigController (issue #355)
// =============================================================================
//
// The HTTP surface behind `/admin/settings/push`. Five operations:
//
//   GET    /api/admin/push-config           push:read
//   PUT    /api/admin/push-config           push:write
//   POST   /api/admin/push-config/generate  push:write
//   POST   /api/admin/push-config/rotate    push:write
//   DELETE /api/admin/push-config           push:write
//
// `push:read`/`push:write` RATHER THAN `system_settings:*`, deliberately —
// see `roles.constants.ts` for the full reasoning (generating/rotating key
// material has a real blast radius: every existing subscriber goes dark).
//
// -----------------------------------------------------------------------------
// A SEPARATE CONTROLLER, NOT A ROUTE ON `NotificationsController`
// -----------------------------------------------------------------------------
//
// Same reasoning as `EmailSettingsController` living apart from
// `SystemSettingsController`: this surface writes a settings row and a
// credential that `NotificationsController`'s existing routes have no reason
// to touch, and keeping it separate keeps the OpenAPI tag — and therefore the
// API reference — aligned with the settings page it backs.
// =============================================================================

@ApiTags('Push Configuration')
@Controller('admin/push-config')
export class PushConfigController {
  constructor(private readonly pushConfig: PushConfigService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.PUSH_READ] })
  @ApiOperation({
    summary: 'Get Web Push configuration (Admin only)',
    description:
      'Returns the Web Push configuration together with `privateKeyStatus`, a masked, ' +
      'non-secret description of the stored VAPID private key. **The private key itself ' +
      'is never returned by this or any other endpoint** — it is held in the encrypted ' +
      'credential store and is unreadable through the API by design.\n\n' +
      '`configured` is `true` only when BOTH a public key is stored and a private-key ' +
      'credential exists; a settings page renders its empty ("Generate & enable") state ' +
      'exactly when this is `false`.',
  })
  @ApiResponse({
    status: 200,
    description: 'Web Push configuration and stored-key status',
    type: PushConfigResponseDto,
  })
  async getConfig() {
    return this.pushConfig.describeForAdmin();
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.PUSH_WRITE] })
  @ApiOperation({
    summary: 'Replace Web Push configuration (Admin only)',
    description:
      'Full replace of `{ enabled, subject }`. **This endpoint flips the switch; it does ' +
      'not manufacture keys** — setting `enabled: true` before a key pair has ever been ' +
      'generated returns `409`. Neither VAPID key is settable here: `publicKey` is ' +
      'server-derived from the `generate`/`rotate` actions, and the private key never ' +
      'travels through this endpoint at all.',
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
    description: 'Updated Web Push configuration',
    type: PushConfigResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({
    status: 409,
    description:
      'Version conflict, or `enabled: true` was requested with no key pair generated yet',
  })
  async replaceConfig(
    @Body() dto: UpdatePushConfigDto,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    // `Number.isInteger` rather than a bare `parseInt`, matching
    // `EmailSettingsController.replaceSettings`: `parseInt('abc')` is `NaN`,
    // and `NaN !== currentVersion` is always true, so a malformed header would
    // turn every save into an unrecoverable 409. Treated as absent instead.
    const parsed = ifMatch !== undefined ? Number.parseInt(ifMatch, 10) : NaN;
    const expectedVersion = Number.isInteger(parsed) ? parsed : undefined;

    return this.pushConfig.update(dto, userId, expectedVersion);
  }

  @Post('generate')
  @Auth({ permissions: [PERMISSIONS.PUSH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate the first VAPID key pair and enable Web Push (Admin only)',
    description:
      'First-time-only key generation: generates a fresh VAPID key pair with `web-push`, ' +
      'stores the private key in the encrypted credential store, stores the public key ' +
      'and sets `enabled: true`. **`409` if a key pair already exists** — use the rotate ' +
      'action to replace an existing configuration instead.',
  })
  @ApiResponse({
    status: 200,
    description: 'The generated configuration',
    type: PushConfigResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: 'Web Push is already configured; use rotate instead',
  })
  async generate(
    @Body() dto: GeneratePushConfigDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.pushConfig.generate(dto, userId);
  }

  @Post('rotate')
  @Auth({ permissions: [PERMISSIONS.PUSH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the VAPID key pair (Admin only)',
    description:
      'Generates a fresh VAPID key pair and replaces the stored one. **Disruptive**: ' +
      'every existing push subscriber stops receiving pushes until their browser next ' +
      'calls `pushManager.subscribe` against the new public key (typically on next app ' +
      'open). `enabled` is left exactly as it was — rotating is not a decision about ' +
      'whether push should be on.\n\n' +
      'Requires the typed confirmation `{ "confirmation": "ROTATE" }` — see this ' +
      "endpoint's request schema. A body copied from the remove endpoint's confirmation " +
      'is rejected: the two use deliberately different words.\n\n' +
      '**`400` if nothing is configured yet** — use the generate action for a first key ' +
      'pair.',
  })
  @ApiResponse({
    status: 200,
    description: 'The rotated configuration',
    type: PushConfigResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Missing/incorrect confirmation, or nothing is configured yet',
  })
  async rotate(
    @Body() dto: RotatePushConfigDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.pushConfig.rotate(dto, userId);
  }

  @Delete()
  @Auth({ permissions: [PERMISSIONS.PUSH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove the Web Push configuration (Admin only)',
    description:
      'Deletes both the stored VAPID private-key credential and the `webPush` settings ' +
      'row, then returns the resulting (empty) configuration — the same shape GET/PUT/ ' +
      'generate/rotate all return, so a client can render the post-removal state without ' +
      'a follow-up GET. **Destructive and immediate** — every existing push subscription ' +
      'becomes unusable, and there is no way to bring the same key pair back; a ' +
      'subsequent `generate` mints an entirely new one.\n\n' +
      'Requires the typed confirmation `{ "confirmation": "REMOVE" }` — deliberately a ' +
      "different word from the rotate endpoint's, so a body copied from one to the other " +
      'is rejected rather than silently accepted.',
  })
  @ApiResponse({
    status: 200,
    description: 'The resulting (now empty) configuration',
    type: PushConfigResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Missing or incorrect confirmation' })
  async remove(
    @Body() dto: RemovePushConfigDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.pushConfig.remove(dto, userId);
  }
}
