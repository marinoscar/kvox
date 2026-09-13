import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../constants/roles.constants';
import { AllowDuringMaintenance } from './allow-during-maintenance.decorator';
import { MaintenanceModeService } from './maintenance-mode.service';
import {
  MaintenanceStatusDto,
  UpdateMaintenanceDto,
} from './dto/update-maintenance.dto';

/**
 * The maintenance window's admin API (#257, epic #254).
 *
 * NO NEW PERMISSION. This IS a system setting — it is stored in the
 * `maintenance` namespace of the `system_settings` row and nowhere else — and
 * `system_settings:read` / `system_settings:write` already mean "may inspect /
 * may change global application behaviour". A dedicated `maintenance:manage`
 * would protect nothing that pair does not already cover, while adding a
 * permission to seed, to assign, and to get wrong. See
 * docs/specs/maintenance-mode.md.
 *
 * `@AllowDuringMaintenance()` on the class, for the obvious reason: the switch
 * that turns the window off must be reachable while the window is open. Note
 * that this exemption is about REACHABILITY only — `@Auth()` still runs, so a
 * caller without `system_settings:write` gets a 403 during a window exactly as
 * they would outside one.
 */
@ApiTags('Maintenance')
@Controller('admin/maintenance')
@AllowDuringMaintenance()
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceModeService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get the maintenance window state',
    description:
      'Returns the effective state together with each contributing layer ' +
      '(environment override, in-memory override, persisted setting) so an ' +
      'operator can see which one is deciding the answer.',
  })
  @ApiResponse({
    status: 200,
    description: 'Effective maintenance state and its layers',
    type: MaintenanceStatusDto,
  })
  async getMaintenance(): Promise<MaintenanceStatusDto> {
    // `fresh: true`: the guard may read a value up to a few seconds old, but an
    // operator inspecting the switch must be shown the row as it is now.
    return (await this.maintenance.resolve({
      fresh: true,
    })) as MaintenanceStatusDto;
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Open or close the maintenance window',
    description:
      'Writes the persisted `maintenance` system-settings namespace and records ' +
      'an audit event. Opening a window stamps who opened it and when; closing ' +
      'one clears both. An environment override, if present, still outranks ' +
      'whatever this writes — check `source` in the response.',
  })
  @ApiResponse({
    status: 200,
    description: 'The state after the write, with its layers',
    type: MaintenanceStatusDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async setMaintenance(
    @Body() dto: UpdateMaintenanceDto,
    @CurrentUser('id') userId: string,
  ): Promise<MaintenanceStatusDto> {
    return (await this.maintenance.setMaintenance(
      {
        enabled: dto.enabled,
        message: dto.message,
        allowAdmins: dto.allowAdmins,
      },
      userId,
    )) as MaintenanceStatusDto;
  }
}
