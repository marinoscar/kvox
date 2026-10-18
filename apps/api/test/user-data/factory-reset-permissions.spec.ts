// =============================================================================
// The factory reset and offboarding permissions, and who holds them (issue #562)
// =============================================================================
//
// `system:factory_reset` gates `/api/admin/factory-reset/*` and the Danger Zone admin
// card; `orgs:offboard` gates organization offboarding. Both are SYSTEM permissions
// declared by the platform's user-data slice (`USER_DATA_PERMISSIONS`) and granted to
// the `admin` system role ONLY. Neither is implied by `system_settings:write`: a role
// that can edit settings must not be able to erase the deployment. The committed
// catalog the seed reads (`prisma/catalog/permissions.json`) is what actually grants
// them, so it is read here, and compared with what the registries hold.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import '../../src/app-registrations/registrations';
import { buildPermissionCatalog } from '@marinoscar/platform-api/core';

const IDS = ['system:factory_reset', 'orgs:offboard'] as const;

type Catalog = {
  permissions: Array<{ name: string; scope: string }>;
  rolePermissions: Record<string, string[]>;
};

describe('system:factory_reset and orgs:offboard', () => {
  const committed = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'prisma', 'catalog', 'permissions.json'), 'utf8'),
  ) as Catalog;
  const registered = buildPermissionCatalog() as unknown as Catalog;

  it.each(IDS)('%s is a system permission in the registries and in the committed catalog', (id) => {
    expect(registered.permissions.find((permission) => permission.name === id)?.scope).toBe('system');
    expect(committed.permissions.find((permission) => permission.name === id)?.scope).toBe('system');
  });

  it.each(IDS)('%s is held by the admin role and by no other', (id) => {
    for (const catalog of [registered, committed]) {
      const holders = Object.entries(catalog.rolePermissions)
        .filter(([, permissions]) => permissions.includes(id))
        .map(([role]) => role);

      expect(holders).toEqual(['admin']);
    }
  });

  it('is not implied by the settings permissions: no role gets it because it can write system settings', () => {
    const writers = Object.entries(committed.rolePermissions)
      .filter(([, permissions]) => permissions.includes('system_settings:write'))
      .map(([role]) => role);

    for (const role of writers) {
      if (role === 'admin') continue;
      for (const id of IDS) expect(committed.rolePermissions[role]).not.toContain(id);
    }
  });

  it('the committed catalog is not stale', () => {
    expect(registered.rolePermissions.admin).toEqual(expect.arrayContaining([...IDS]));
    expect(committed.rolePermissions.admin).toEqual(registered.rolePermissions.admin);
  });
});
