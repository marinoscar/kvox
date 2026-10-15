/**
 * Admin → Settings → Maintenance (`/admin/settings/maintenance`).
 *
 * The platform's page (issue #464, epic #462): the switch and the layers that
 * decide whether the deployment is in a maintenance window, over
 * `GET|PUT /api/admin/maintenance`. A registry card in
 * `config/adminSections.tsx` and a route in `App.tsx`; nothing else is this
 * app's. The screen a BLOCKED user sees is the packaged `MaintenanceGate`'s.
 */
export { MaintenancePage as default } from '@marinoscar/platform-web/host/ui';
