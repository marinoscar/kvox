import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  AiCredentialListDto,
  AiConnectionTestDto,
  AiCredentialStatusDto,
  SaveAiCredentialDto,
  TestAiCredentialDto,
} from './dto/ai-credentials.dto';
import { UserAiCredentialsService } from './user-ai-credentials.service';

// =============================================================================
// AiCredentialsController (issue #47, epic #45)
// =============================================================================
//
// A user's OWN AI provider key. Four operations, all `@Auth()` with NO
// permission — and that is the deliberate answer, not an oversight:
//
//   GET    /api/ai-credentials             authenticated
//   PUT    /api/ai-credentials             authenticated
//   DELETE /api/ai-credentials/{provider}  authenticated
//   POST   /api/ai-credentials/test        authenticated
//
// -----------------------------------------------------------------------------
// WHY NO PERMISSION STRING GATES THESE FOUR
// -----------------------------------------------------------------------------
//
// Every OTHER capability probe in this codebase that could have been left
// merely authenticated was given a real permission instead — `GET
// /api/transcription/config` names `transcripts:read`, `GET /api/ai/config`
// below it names `notes:read` — because a permission that is seeded to all
// three roles says something true about WHAT the route belongs to, where
// "authenticated and nothing else" says nothing at all.
//
// These four are the case where that argument genuinely does not apply. The
// resource is not a feature of this application; it is THE CALLER'S OWN
// CREDENTIAL, scoped by `userId` in the query itself. An RBAC permission gates
// what a role may do to the application's resources; nothing about a role
// should decide whether a person may manage a secret that belongs to them and
// is billed to them. The nearest precedent in this repository is
// `/api/user-settings` and `/api/pat`, which are likewise ownership-scoped
// rather than permission-scoped — and `notes:read` would be the WRONG gate
// here, because a user must be able to remove their own key from a deployment
// that has since revoked their access to the feature it was for.
//
// -----------------------------------------------------------------------------
// OWNERSHIP IS ENFORCED IN THE QUERY, NOT BY A GUARD
// -----------------------------------------------------------------------------
//
// `@CurrentUser('id')` comes from the verified JWT and is passed to every
// service call, which puts it in the `where` clause itself. There is no route
// parameter naming a user, so there is no id for a caller to substitute: one
// user reading, replacing or deleting another's credential is not something
// these routes refuse, it is something they cannot express.
//
// ⚠ NO RESPONSE ON ANY ROUTE BELOW EVER CONTAINS THE SECRET. `apiKey` exists on
// two REQUEST bodies and in no response schema; the presentation query does not
// select the ciphertext column at all. The integration test asserts this
// against the SERIALIZED body rather than the DTO.
// =============================================================================

@ApiTags('AI')
@Controller('ai-credentials')
export class AiCredentialsController {
  constructor(private readonly credentials: UserAiCredentialsService) {}

  @Get()
  @Auth()
  @ApiOperation({
    summary: "Get the calling user's own AI key status",
    description:
      'Returns **your own** stored AI keys — one entry per provider you have set up — with a ' +
      'masked hint, your label and timestamps.\n\n' +
      '**The key itself is never returned.** It is encrypted at rest under a key this ' +
      'application holds only in its environment, and no endpoint, for any role including an ' +
      'administrator, can read it back. `hint` is a mask such as `••••a1b2`.\n\n' +
      'Scoped to the authenticated caller by construction — there is no parameter naming a ' +
      'user, so there is no way to ask for anybody else\'s.',
  })
  @ApiResponse({
    status: 200,
    description: "The caller's own key statuses, masked",
    type: AiCredentialListDto,
  })
  async list(@CurrentUser('id') userId: string) {
    return { credentials: await this.credentials.list(userId) };
  }

  @Put()
  @Auth()
  @ApiOperation({
    summary: "Save or replace the calling user's own AI key",
    description:
      'Stores **your own** provider API key, encrypted. Replacing an existing key for the ' +
      'same provider overwrites it; there is never a second row.\n\n' +
      '`apiKey` is **write-only**: it is never returned by this or any other endpoint. Send ' +
      'it blank or omit it to keep the key you already stored (useful for changing only the ' +
      'label) — blank never means "erase". Erasing is ' +
      '`DELETE /api/ai-credentials/{provider}`.\n\n' +
      'A blank key with nothing already stored is a 400, because this endpoint\'s whole ' +
      'purpose is the key and a 200 that changed nothing would be misleading.\n\n' +
      '⚠ This key is billed to **your** provider account. This application never uses it for ' +
      'anybody but you, and there is no deployment-wide key it can fall back on.',
  })
  @ApiResponse({
    status: 200,
    description: 'The stored key status, masked. Never contains the key.',
    type: AiCredentialStatusDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Unknown provider, or no key supplied and none stored',
  })
  async save(
    @Body() dto: SaveAiCredentialDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.credentials.save(
      { provider: dto.provider, apiKey: dto.apiKey, label: dto.label },
      userId,
    );
  }

  @Post('test')
  @Auth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Test an AI key (including one that has not been saved)",
    description:
      'Probes the provider with the supplied key, or with your stored key when none is ' +
      'supplied. **The supplied key does not need to have been saved** — proving a key before ' +
      'committing it is the workflow this endpoint exists for.\n\n' +
      '⚠ **This returns HTTP 200 even when the probe failed.** A refused probe is a ' +
      'successful diagnosis, and it is the reason this endpoint exists — read the `ok` field, ' +
      'and show `detail`, which distinguishes "the key is wrong", "the key is valid but the ' +
      'account is rate-limited or out of credit" and "the endpoint was unreachable". Treating ' +
      '200 as "the key works" reports success for every misconfiguration there is.\n\n' +
      'A 400 means the request itself was unusable — an unknown provider, or no key supplied ' +
      'and none stored — which is a different thing from a failed probe.\n\n' +
      'The key is used for this one outbound request and dropped; an unsaved key is never ' +
      'written anywhere.',
  })
  @ApiResponse({
    status: 200,
    description: 'The outcome of the probe. Check `ok`; on failure `detail` names the fix.',
    type: AiConnectionTestDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Unknown provider, or no key supplied and none stored',
  })
  async testConnection(
    @Body() dto: TestAiCredentialDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.credentials.testConnection(
      { provider: dto.provider, apiKey: dto.apiKey },
      userId,
    );
  }

  @Delete(':provider')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Erase the calling user's own AI key for one provider",
    description:
      'Erases **your own** stored key for one provider. This is the **only** way to remove a ' +
      'key — submitting an empty `apiKey` on `PUT` preserves the stored one, deliberately, ' +
      'because the form renders that box empty.\n\n' +
      'Idempotent: removing a key that is not there succeeds, because the goal is "there is ' +
      'no key here" and a double-clicked button should not produce an error.\n\n' +
      'Scoped to the authenticated caller, so this can only ever erase your own key.',
  })
  @ApiParam({
    name: 'provider',
    description: 'The provider id whose key to erase, e.g. `openai`.',
  })
  @ApiResponse({ status: 204, description: 'The key is gone (or was never there)' })
  @ApiResponse({ status: 400, description: 'Unknown provider' })
  async remove(
    @Param('provider') provider: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.credentials.remove(userId, provider);
  }
}
