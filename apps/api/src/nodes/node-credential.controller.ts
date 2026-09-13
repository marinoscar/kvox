// =============================================================================
// /api/node-credentials — minting and revoking worker credentials (#267, #254)
// =============================================================================
//
// Three operations, one resource, no surprises: create one (and see the raw
// token, once), list your own (masked), revoke one. What is worth writing
// down is the two decisions that are NOT obvious from the shapes.
//
// -----------------------------------------------------------------------------
// 1. WHY THESE ROUTES ARE UNREACHABLE WITH THE VERY CREDENTIAL THEY MINT
// -----------------------------------------------------------------------------
//
// `JwtAuthGuard`'s `nod_` branch allowlists `/api/nodes` and `/api/nodes/*`
// and NOTHING ELSE — `/api/node-credentials` is deliberately not on that list,
// even though it is this token family's own management surface and even
// though the caller would be the credential's own owner.
//
// That looks like an oversight until you name the attack it prevents.
// Self-management is credential MINTING: a worker token that could reach
// `POST /api/node-credentials` could mint a second credential, and a third,
// each with no expiry, none of which the operator asked for and none of which
// revoking the leaked one removes. Revocation would stop being a control at
// all — you would be playing whack-a-mole against a token that can regrow.
// So a `nod_` token cannot reach even its own management routes; those need a
// real session or a `pat_` token, i.e. a human or a human's deliberate
// automation. This is asserted, not assumed: see the 403 cases in
// `test/nodes/node-credential-guard.integration.spec.ts`.
//
// -----------------------------------------------------------------------------
// 2. WHY THE LIST IS `nodes:read` AND NOT `@Auth()` WITH NO PERMISSION
// -----------------------------------------------------------------------------
//
// `PatController.listTokens` is a bare `@Auth()` — any authenticated user may
// list their own PATs — and copying that here would have been the path of
// least resistance. It would also have been wrong, for two reasons:
//
//   * The Settings UI Pattern (CLAUDE.md rule 3) requires a settings card's
//     `permission` to be THE EXACT STRING the controller enforces. A Workers
//     surface is gated on `nodes:read`/`nodes:write` (see `openapi/tags.ts`,
//     which already publishes that claim). If this list were ungated, the hub
//     and the API would disagree about who can see it, and the hub would be
//     the one lying.
//
//   * A PAT is a personal convenience; a node credential is FLEET
//     INVENTORY. The list answers "which credentials can attach a machine to
//     this deployment, when was each last used, which are still live" — an
//     operational question about the deployment, not a private question about
//     the caller. `prisma/seed-data.ts` deliberately grants `nodes:read` to
//     Admin only for exactly this reason: host names and attachment state
//     describe the shape of the deployment.
//
// `nodes:read` rather than `nodes:write` for the list because reading is not
// writing, and a role that may audit the fleet without being able to mint new
// access to it is a distinction worth being able to express — that is the
// entire reason the permission pair is split. Create and revoke are
// `nodes:write`: both change which machines can authenticate.
// =============================================================================

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { CreateNodeCredentialDto } from './dto/create-node-credential.dto';
import {
  NodeCredentialCreatedResponseDto,
  NodeCredentialListItemDto,
} from './dto/node-credential-response.dto';
import { NodeCredentialService } from './node-credential.service';

@ApiTags('Worker Nodes')
@Controller('node-credentials')
export class NodeCredentialController {
  constructor(private readonly credentials: NodeCredentialService) {}

  @Post()
  @Auth({ permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Mint a worker node credential',
    description:
      'Creates a `nod_…` bearer credential a worker node authenticates with, and ' +
      'returns it IN FULL EXACTLY ONCE — the server stores only a hash and can never ' +
      'show it again. Omit `expiresInDays` for a credential that never expires, which ' +
      'is the intended default for an unattended node; revocation, not a clock, is the ' +
      'control. A `nod_` token is confined by the authentication guard to `/api/nodes/*` ' +
      'and cannot reach this endpoint, so it can never mint another credential.',
  })
  @ApiResponse({
    status: 201,
    description: 'Credential created — `token` is shown only in this response',
    type: NodeCredentialCreatedResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async createCredential(
    @Body() dto: CreateNodeCredentialDto,
    @CurrentUser('id') userId: string,
  ): Promise<NodeCredentialCreatedResponseDto> {
    return this.credentials.createCredential(userId, dto);
  }

  @Get()
  // See the file header, section 2, for why this is `nodes:read` and not a
  // bare `@Auth()` the way the equivalent PAT listing is.
  @Auth({ permissions: [PERMISSIONS.NODES_READ] })
  @ApiOperation({
    summary: "List the caller's worker node credentials",
    description:
      'Returns each credential masked to its display prefix. The raw token is never ' +
      'included here and cannot be recovered — nor is the stored hash returned, which ' +
      'would otherwise let a leaked listing be used to verify guessed tokens offline.',
  })
  @ApiResponse({
    status: 200,
    description: 'Masked credentials, newest first',
    type: [NodeCredentialListItemDto],
  })
  async listCredentials(
    @CurrentUser('id') userId: string,
  ): Promise<NodeCredentialListItemDto[]> {
    const rows = await this.credentials.listCredentials(userId);

    // Dates are serialized here rather than being handed to the global
    // interceptor as `Date` objects, matching `PatController` — the wire
    // contract this controller documents is ISO 8601 strings, and mapping
    // explicitly is what makes `expiresAt: null` visibly a real value in this
    // response rather than a field that happens to be missing.
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    }));
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke a worker node credential',
    description:
      'Takes effect on the node’s very next request — the guard re-reads `revokedAt` ' +
      'on every authentication, so nothing is cached and there is no TTL to wait out. ' +
      'Revocation is one-way; a node that needs to come back needs a new credential.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Credential revoked' })
  @ApiResponse({
    status: 404,
    description: 'Not found, not yours, or already revoked (deliberately indistinguishable)',
  })
  async revokeCredential(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.credentials.revokeCredential(userId, id);
  }
}
