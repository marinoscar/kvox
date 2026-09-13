// =============================================================================
// /api/admin/nodes — the fleet as an administrator sees it (issue #270, epic #254)
// =============================================================================
//
// The admin counterpart to `NodesController`, and mounted on a DIFFERENT
// PREFIX for a reason that is not organisational:
//
//   `JwtAuthGuard` admits a `nod_` credential on `/api/nodes` and paths
//   beneath it, and refuses it everywhere else (#267). Every route mounted
//   under `NodesController` is therefore reachable by an unattended,
//   months-old worker token on somebody else's box. These routes list every
//   node in the deployment with its OWNER'S EMAIL, and delete nodes and
//   credentials belonging to other people — none of which belongs inside that
//   blast radius. Mounting them at `admin/nodes` puts them outside the
//   allowlist by construction rather than by a check somebody has to remember.
//
// The controller binds, documents and authorizes; every decision lives in
// `nodes-admin.service.ts`, including the derived health verdict and the
// single `groupBy` behind the job counts.
//
// -----------------------------------------------------------------------------
// ⚠ THE `credentials` LITERALS ARE DECLARED BEFORE `:id`, AND THE ORDER IS
// LOAD-BEARING
// -----------------------------------------------------------------------------
//
// Nest matches routes in DECLARATION ORDER, not by specificity.
// `GET /admin/nodes/credentials` is one segment past the prefix — exactly the
// shape `GET /admin/nodes/:id` matches — so declaring `:id` first captures it
// with `id = 'credentials'`, `ParseUUIDPipe` rejects that, and an
// administrator pressing "credentials" is told
// `400 Validation failed (uuid is expected)`: a message that names nothing
// about the real mistake, in a file nobody would think to open. No error at
// boot, no warning in the log.
//
// `DELETE /admin/nodes/credentials/:id` is two segments and could not be
// captured by today's one-segment `:id` whatever the order — but it is
// declared with the other literal anyway. The rule that survives is "every
// literal above every parameterised route", not "every literal that would
// currently break"; a later `:id/:action` route would swallow it silently, and
// by then nobody is re-deriving which literals were safe by accident. This is
// the same rule `job-admin.controller.ts` and `nodes.controller.ts` state, and
// `test/nodes/nodes-admin.integration.spec.ts` drives
// `GET /api/admin/nodes/credentials` through the real router to prove it did
// not resolve as `:id`.
//
// -----------------------------------------------------------------------------
// PERMISSIONS: THE SAME PAIR THE OWNER-SCOPED PLANE USES
// -----------------------------------------------------------------------------
//
// `nodes:read` for the two lists and the detail, `nodes:write` for the two
// deletions, both additionally gated on the Admin role — matching
// `job-admin.controller.ts`, where the role admits and the permission is what
// the guard checks. Deliberately NOT a new `nodes:admin` permission: the split
// that matters is read-versus-write (an operations role that may AUDIT the
// fleet without being able to delete any of it), and the deployment-versus-own
// scope is already expressed by the route prefix and the Admin role. A third
// string would have to be seeded, documented and mirrored in a settings card,
// and would express nothing the two existing ones plus the role do not.
//
// These exact strings are the API half of the contract a settings card's
// `permission` field must mirror byte for byte (CLAUDE.md, Settings UI Pattern
// rule 3).
// =============================================================================

import { Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { AdminNodeCredentialDto, AdminNodeDto } from './dto/node-admin.dto';
import { NodesAdminService } from './nodes-admin.service';

@ApiTags('Worker Nodes')
@Controller('admin/nodes')
export class NodesAdminController {
  constructor(private readonly nodes: NodesAdminService) {}

  // ---------------------------------------------------------------------------
  // Literal routes. Nothing parameterised may be declared above this block —
  // see the file header.
  // ---------------------------------------------------------------------------

  @Get('credentials')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.NODES_READ] })
  @ApiOperation({
    summary: 'List every node credential in the deployment, with its owner',
    description:
      'The audit view of the `nod_` tokens that can reach `/api/nodes`. A node credential has ' +
      'no mandatory expiry — a worker runs unattended for months, and revocation rather than a ' +
      'clock is the intended control — so this list is how an administrator answers "which ' +
      'long-lived tokens exist, whose are they, and which have not been used in a year". ' +
      'Masked: the raw token is shown exactly once at creation and the stored hash is never ' +
      'returned. Revoked credentials are included, with `revokedAt` set, because a revoked ' +
      'token is part of the audit trail.',
  })
  @ApiResponse({ status: 200, description: 'Every credential', type: [AdminNodeCredentialDto] })
  async listCredentials(): Promise<AdminNodeCredentialDto[]> {
    return this.nodes.listCredentials();
  }

  @Delete('credentials/:id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke any node credential',
    description:
      'Cuts a worker token off immediately, whoever owns it — the control that replaces a ' +
      'mandatory expiry. Revocation is a one-way door: `revokedAt` is stamped once and never ' +
      'cleared, and a node holding the token gets `401` on its very next request. Revoking an ' +
      'already-revoked credential is `404` rather than a silent success, so an administrator ' +
      'racing another one is told the state changed under them. Deleting the credential is NOT ' +
      'the same thing and is not offered: the row is the record that the token existed.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Credential revoked' })
  @ApiResponse({ status: 404, description: 'No such credential, or it was already revoked' })
  async revokeCredential(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.nodes.revokeCredential(id);
  }

  @Get()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.NODES_READ] })
  @ApiOperation({
    summary: 'List the whole fleet, with derived health and job counts',
    description:
      'Every worker node in the deployment, whoever registered it, with its owner and its job ' +
      'counts by status. Read `status` and `health` together and do not confuse them: `status` ' +
      'is operator state (`disabled` refuses claims, `draining` finishes what it holds), while ' +
      '`health` is DERIVED from `lastHeartbeatAt` at read time — `healthy` inside the ' +
      '`nodes.staleHeartbeatSeconds` window, `stale` outside it, `offline` when the status ' +
      'already says so. A node that crashed reads `stale` until the fleet sweep marks it ' +
      '`offline`, and `offline` thereafter. Counts come from one grouped query for the whole ' +
      'fleet, so this endpoint is safe to poll.',
  })
  @ApiResponse({ status: 200, description: 'The whole fleet', type: [AdminNodeDto] })
  async list(): Promise<AdminNodeDto[]> {
    return this.nodes.listFleet();
  }

  // ---------------------------------------------------------------------------
  // Parameterised routes. Nothing literal may be declared below this line.
  // ---------------------------------------------------------------------------

  @Get(':id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.NODES_READ] })
  @ApiOperation({
    summary: 'Get one node, whoever owns it',
    description:
      'The same shape the fleet list returns, for a single node — including the health verdict, ' +
      'which is computed by the same function against the same policy, so this view and the ' +
      'list can never disagree about whether a node is stale. `404` when there is no such ' +
      'node; never `403`, because an administrator’s scope is the whole deployment.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The node', type: AdminNodeDto })
  @ApiResponse({ status: 404, description: 'No such node' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminNodeDto> {
    return this.nodes.getNode(id);
  }

  @Delete(':id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a node record, whoever owns it',
    description:
      'Forgets the node — the manual equivalent of what the retention prune does on a timer. ' +
      'Jobs are NOT deleted: their `claimedByNodeId` is cleared and the rows stay exactly as ' +
      'they were, so a job this node was running is picked up by the lease reaper and requeued ' +
      'or failed on its normal attempt budget. Unlike the automatic prune this is allowed even ' +
      'while the node holds running jobs, because the node an administrator deletes is usually ' +
      'the one that is never coming back and whose jobs they are trying to unstick. Deleting a ' +
      'node does NOT revoke its credential: the same token can register a new node, so revoke ' +
      'it too if the machine is gone for good.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Node deleted' })
  @ApiResponse({ status: 404, description: 'No such node' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.nodes.deleteNode(id);
  }
}
