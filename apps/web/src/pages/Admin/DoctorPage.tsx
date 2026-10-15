/**
 * Admin → Settings → Doctor (`/admin/settings/doctor`).
 *
 * The platform's page (issue #464, epic #462): the deployment's health checks
 * from `GET /api/admin/doctor` (the platform's own plus this app's, registered
 * on the API) and the support bundle download. A registry card in
 * `config/adminSections.tsx` (`doctorSettingsPage.card`, `system_settings:read`)
 * and a route in `App.tsx`; nothing else is this app's.
 */
import { doctorSettingsPage } from '@marinoscar/platform-web/doctor/ui';

export default doctorSettingsPage.Page;
