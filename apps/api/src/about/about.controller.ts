import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ABOUT_RESPONSE_EXAMPLE, AboutResponseDto } from './about.dto';
import { AboutService } from './about.service';

/**
 * `GET /api/admin/about` (issue #124, epic #118).
 *
 * GATED ON `system_settings:read`, NOT A NEW `about:read` (epic decision 8).
 * "What is deployed here" is an administrator's configuration read, and the
 * web card (#126) must carry the exact string this controller enforces
 * (CLAUDE.md Settings UI rule 3). A permission no role is seeded with would be
 * a card nobody could open until every deployment re-seeded its roles.
 *
 * DELIBERATELY NOT `@AllowDuringMaintenance()`. This is an admin page, and an
 * administrator already bypasses the window unless `allowAdmins` is false —
 * in which case nothing but the maintenance switch itself should answer.
 *
 * No audit event: this is a read.
 */
@ApiTags('About')
@Controller('admin/about')
export class AboutController {
  constructor(private readonly about: AboutService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'What is deployed here',
    description:
      'The deployment record the CLI wrote at deploy time (`deploy-info/info.json`: app ' +
      'version, commit, ref, install/update timestamps, host facts, and the last remote ' +
      'check), plus what only the running process knows (its version, Node, start time, ' +
      'clock) and what only a live database connection can answer (server version, ' +
      'applied migrations).\n\n' +
      'Always answers **200**. A deployment without the file — the local dev stack, CI — ' +
      'answers `deployInfo: null` with `deployInfoStatus: "absent"`; a torn or malformed ' +
      'file answers `"unreadable"` or `"invalid"` with the reason in `detail`; an ' +
      'unreachable database answers `database: null` with `databaseError` set. The file is ' +
      'read on every request, so rewriting it takes effect without a restart.\n\n' +
      '**Never performs network I/O.** `updateAvailable` and `checkedAt` are derived from ' +
      'the `remote` block the CLI last recorded (the deploy CLI, `deploy update --check`), never from ' +
      'a call made here; both are `null` until the CLI has checked at least once. Every ' +
      'timestamp is ISO-8601 UTC.',
  })
  @ApiResponse({
    status: 200,
    description: 'Deployment record, runtime facts and database facts',
    type: AboutResponseDto,
    example: ABOUT_RESPONSE_EXAMPLE,
  })
  async getAbout(): Promise<AboutResponseDto> {
    return (await this.about.get()) as AboutResponseDto;
  }
}
