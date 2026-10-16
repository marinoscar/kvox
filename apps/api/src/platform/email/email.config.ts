// =============================================================================
// The email slice's composition (issue #470, epic #467)
// =============================================================================
//
// `EmailModule.forRoot` replaces this app's own `email/` folder: the SES and
// SMTP transports, the `email` settings row and its admin routes
// (`GET|PUT /api/email-settings`, `POST /api/email-settings/test`, all
// `system_settings:read|write`), the template registry and layout, and the
// doctor check. The platform templates (`test-email`, `broadcast`,
// `job-failed`, `node-offline`, `backup-failed`, `restore-completed`, and the
// three identity ones) come with it; this app's own are registered by
// `email-templates/index.ts` (`KVOX_EMAIL_TEMPLATES`) from
// `platform/notifications/notification.manifest.ts`.
//
// NOT GLOBAL: `SmtpEmailProvider` reaches the plaintext `CredentialsService`
// secret reader, so every consumer writes `imports: [emailModule]` and shows up
// in a diff. Export the one `forRoot()` result and import THAT object
// everywhere (one module to Nest). It needs `SettingsModule.forRoot()` (the row
// store), `PlatformHostModule` (`PLATFORM_PRISMA`, `AUDIT_SINK`) and the
// credentials store, all mounted by `app.module.ts`.
//
// The credential purposes (`smtp`, `email_ses`) are registered by
// `platform/credentials/credential-purposes.manifest.ts`; the strings are the
// ones this app has always stored, so no row is rewritten.
// =============================================================================

import { EmailModule } from '@marinoscar/platform-api/email';

import { EMAIL_MODULE_OPTIONS } from './email.options';

export { EMAIL_MODULE_OPTIONS };

export const emailModule = EmailModule.forRoot(EMAIL_MODULE_OPTIONS);
