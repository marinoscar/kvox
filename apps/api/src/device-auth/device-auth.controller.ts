import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { DeviceAuthService } from './device-auth.service';
import { Public } from '../auth/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

// Request DTOs
import { DeviceCodeRequestDto } from './dto/device-code-request.dto';
import { DeviceTokenRequestDto } from './dto/device-token-request.dto';
import { DeviceAuthorizeRequestDto } from './dto/device-authorize-request.dto';

// Response DTOs
import { DeviceCodeResponseDto } from './dto/device-code-response.dto';
import { DeviceTokenResponseDto } from './dto/device-token-response.dto';
import { DeviceTokenErrorDto } from './dto/device-token-error.dto';
import { DeviceActivateResponseDto } from './dto/device-activate-response.dto';
import { DeviceAuthorizeResponseDto } from './dto/device-authorize-response.dto';
import { DeviceSessionsResponseDto } from './dto/device-session.dto';
import { AllowDuringMaintenance } from '../common/maintenance/allow-during-maintenance.decorator';

@ApiTags('Device Authorization')
@Controller('auth/device')
export class DeviceAuthController {
  constructor(private readonly deviceAuthService: DeviceAuthService) {}

  /**
   * POST /auth/device/code
   * Generate a new device code pair for device authorization flow
   */
  @Public()
  @Post('code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate device code',
    description:
      'Initiates the device authorization flow by generating a device code and user code pair. ' +
      'The device displays the returned `userCode` and sends the user to the returned ' +
      '`verificationUri` (or `verificationUriComplete`, which has the code pre-filled); in this ' +
      'application that URI resolves to the `/activate` page. Use the returned field rather than ' +
      'hardcoding the path. Meanwhile the device polls `POST /auth/device/token` until the user ' +
      'approves or the code expires. ' +
      'Set `clientInfo.tokenType` to `pat` to be issued a long-lived, revocable personal access ' +
      'token instead of the default `session` credential (short-lived access token + refresh ' +
      'token); an unrecognised value is rejected with a 400 rather than falling back.',
  })
  @ApiResponse({
    status: 200,
    description: 'Device code generated successfully',
    type: DeviceCodeResponseDto,
  })
  async generateCode(
    @Body() body: DeviceCodeRequestDto,
  ): Promise<{ data: DeviceCodeResponseDto }> {
    const result = await this.deviceAuthService.generateDeviceCode(
      body.clientInfo,
    );

    return { data: result };
  }

  /**
   * POST /auth/device/token
   * Poll for device authorization status
   */
  @Public()
  @Post('token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Poll for device authorization',
    description:
      'Device polls this endpoint to check if the user has authorized the device. ' +
      'Returns the credential when approved, or an RFC 8628 error code while ' +
      'pending/denied/expired. The credential is minted HERE, on the poll — approval records ' +
      'intent only — so a device that is approved but never polls is never issued one, and the ' +
      'device code is consumed by the poll that succeeds.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Device authorized. Returns the credential kind requested at `POST /auth/device/code`: ' +
      'the default `session` credential (access token plus `refreshToken`), or a personal ' +
      'access token when `clientInfo.tokenType` was `pat`, which carries `credentialType: ' +
      '"pat"`, `expiresAt`, `tokenId`, `tokenName` and NO refresh token. Branch on ' +
      '`credentialType`, never on the absence of `refreshToken`.',
    type: DeviceTokenResponseDto,
  })
  // The two error responses below are the ONLY ones in this API that are not
  // the shared `ErrorDto` envelope. RFC 8628 §3.5 fixes the token endpoint's
  // error body as `{ error, error_description }` at the top level, and the
  // `error` value is the whole protocol — the client polls on
  // `authorization_pending`, backs off on `slow_down`, restarts on
  // `expired_token` and gives up on `access_denied`. `DeviceAuthService` throws
  // these through `deviceTokenError()`, which brands them so
  // `HttpExceptionFilter` passes the body through instead of flattening it
  // (#153). Documented here on both statuses so the published spec matches what
  // the endpoint actually sends.
  @ApiResponse({
    status: 400,
    description:
      'Authorization pending, slow down, expired, or denied (see error field). ' +
      'RFC 8628 body, NOT the shared error envelope.',
    type: DeviceTokenErrorDto,
  })
  @ApiResponse({
    status: 401,
    description:
      'The device code is unknown or has already been redeemed (`invalid_grant`). ' +
      'RFC 8628 body, NOT the shared error envelope.',
    type: DeviceTokenErrorDto,
  })
  async pollToken(
    @Body() body: DeviceTokenRequestDto,
  ): Promise<{ data: DeviceTokenResponseDto }> {
    const result = await this.deviceAuthService.pollForToken(body.deviceCode);

    return { data: result };
  }

  /**
   * GET /auth/device/activate
   * Get activation page information
   */
  @Get('activate')
  // Reachable during a maintenance window (#257): this and `authorize` below
  // are the BROWSER half of the device flow, driven by a signed-in human on
  // the activation page. The polling half (`code` / `token`) is deliberately
  // NOT exempt — those belong to unattended clients, which is precisely what a
  // window is asking to back off, and they get the 503's `Retry-After` for it.
  @AllowDuringMaintenance()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Get device activation info',
    description:
      'Returns information for the device activation page — the `verificationUri` this ' +
      'deployment hands out (the `/activate` page) and, when a `code` is supplied, the ' +
      'pending request it identifies: its `userCode`, the `clientInfo` the device sent, and ' +
      'when the code expires. `clientInfo` is supplied by an unauthenticated caller, so treat ' +
      'it as untrusted when displaying it.',
  })
  @ApiQuery({
    name: 'code',
    required: false,
    description: 'User verification code (optional)',
    example: 'ABCD-1234',
  })
  @ApiResponse({
    status: 200,
    description: 'Activation information',
    type: DeviceActivateResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'The code has expired, or has already been approved or denied',
  })
  @ApiResponse({
    status: 404,
    description: 'No device code matches this user code',
  })
  async getActivationInfo(
    @Query('code') code?: string,
  ): Promise<{ data: DeviceActivateResponseDto }> {
    const result = await this.deviceAuthService.getActivationInfo(code);

    return { data: result };
  }

  /**
   * POST /auth/device/authorize
   * Authorize or deny a device
   */
  @Post('authorize')
  // Reachable during a maintenance window (#257) — see `activate` above.
  @AllowDuringMaintenance()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Authorize or deny device',
    description:
      'User authorizes or denies a device using the user code from the activation page. ' +
      'Approval records INTENT ONLY (the request is marked approved and bound to this user); ' +
      'no credential is created here. The device receives its credential — session token or ' +
      'personal access token — on its next poll of `POST /auth/device/token`.',
  })
  @ApiResponse({
    status: 200,
    description: 'Device authorization processed',
    type: DeviceAuthorizeResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'The code has expired, or has already been approved or denied',
  })
  @ApiResponse({
    status: 404,
    description: 'No device code matches this user code',
  })
  async authorizeDevice(
    @CurrentUser() user: RequestUser,
    @Body() body: DeviceAuthorizeRequestDto,
  ): Promise<{ data: DeviceAuthorizeResponseDto }> {
    const result = await this.deviceAuthService.authorizeDevice(
      user.id,
      body.userCode,
      body.approve,
    );

    return { data: result };
  }

  /**
   * GET /auth/device/sessions
   * List user's approved device sessions
   */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'List device sessions',
    description:
      "Returns a paginated list of the current user's device authorizations that are still " +
      'in the `approved` state — that is, approved but not yet redeemed. A request leaves ' +
      'this list once the device collects its credential on `POST /auth/device/token`, so ' +
      'this is not a list of live credentials.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size',
    example: 10,
  })
  @ApiResponse({
    status: 200,
    description: 'List of device sessions',
    type: DeviceSessionsResponseDto,
  })
  async getSessions(
    @CurrentUser() user: RequestUser,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<{ data: DeviceSessionsResponseDto }> {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    const result = await this.deviceAuthService.getUserDeviceSessions(
      user.id,
      pageNum,
      limitNum,
    );

    return { data: result };
  }

  /**
   * DELETE /auth/device/sessions/:id
   * Revoke a device session
   */
  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Revoke device session',
    description:
      'Revokes one of the current user\'s device authorizations, so the device can no longer ' +
      'redeem it on the token endpoint. It does NOT invalidate a credential the device has ' +
      'already collected: revoke a personal access token with `DELETE /api/pat/{id}`; for a ' +
      'session credential `POST /auth/logout-all` revokes the refresh tokens, while the ' +
      'issued access token stays valid until it expires.',
  })
  @ApiResponse({
    status: 200,
    description: 'Session revoked successfully',
    type: DeviceAuthorizeResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Session not found',
  })
  async revokeSession(
    @CurrentUser() user: RequestUser,
    @Param('id') sessionId: string,
  ): Promise<{ data: DeviceAuthorizeResponseDto }> {
    const result = await this.deviceAuthService.revokeDeviceSession(
      user.id,
      sessionId,
    );

    return { data: result };
  }
}
