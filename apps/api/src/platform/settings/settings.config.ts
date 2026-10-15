// =============================================================================
// The settings slice's composition (issue #466, epic #462)
// =============================================================================
//
// `SettingsModule.forRoot` serves `GET|PUT|PATCH /api/system-settings`,
// `GET|PUT|PATCH /api/user-settings` and `/api/org-settings` (unused in
// single-organization mode), and provides `SystemSettingsService`,
// `UserSettingsService`, `SettingsResolver` and `SystemSettingsRowStore`
// globally. Replaces this app's own `SettingsModule`.
//
// IT MUST RUN AFTER THE NAMESPACE MANIFESTS: the request bodies and the OpenAPI
// document are composed from the registries when `forRoot` runs, so the import
// below comes first. `systemRowKey` stays `'global'` (the row this app has always
// used) and `orgLayer` is `'auto'`: in single-organization mode an organization
// layer applies only when its row exists, which here it never does.
// =============================================================================

import { SettingsModule } from '@marinoscar/platform-api/settings';

import '../../settings/registry';
import { SettingsHostModule } from './settings-host.module';

export const settingsModule = SettingsModule.forRoot({
  systemRowKey: 'global',
  orgLayer: 'auto',
  imports: [SettingsHostModule],
});
