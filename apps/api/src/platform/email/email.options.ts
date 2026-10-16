// =============================================================================
// The email slice's options (issue #470, epic #467)
// =============================================================================
//
// ONE object, three readers:
//
//   * `EmailModule.forRoot(EMAIL_MODULE_OPTIONS)` in `email.config.ts`
//   * `configureEmailRendering(EMAIL_MODULE_OPTIONS)` in
//     `platform/notifications/notification.manifest.ts`, which renders
//     templates before the Nest graph is composed
//   * the template specs under `email-templates/`
//
// THE LAYOUT. The platform layout is the one this app's own layout always was
// (same palette, same font stack, same footer), so the only theme token set
// here is the brand colour, taken from `packages/shared/identity.json` through
// `@app/shared` (`THEME_COLOR`) so a rebrand reaches the mail with the web
// manifest and the icons. The brand mark is the committed PNG under
// `apps/api/assets/email/logo.png` (`email-templates/brand-logo.ts`): since
// #470 the platform layout shows it on EVERY message, where this app's own
// layout showed it on the two invitations only.
//
// THE SES REGION. An admin-entered region wins; this is the deployment default
// the app has always read (`S3_REGION`, no built-in default: a guessed region
// is reported by SES as an unverified identity, which is a worse error than
// "no region configured"). The SES ACCESS KEY ID and SECRET are NOT read from
// the environment any more: the platform stores them with the email settings
// (`email` row and the `email_ses` credential), see docs/API.md.
// =============================================================================

import { APP_NAME, THEME_COLOR } from '@app/shared';
import type { EmailModuleOptions } from '@marinoscar/platform-api/email';
import { classifyRateLimit } from '@marinoscar/platform-api/jobs';

import { emailBrandMark } from '../../email-templates/brand-logo';

/** The deployment's base URL when `APP_URL` is unset (the dev default `config/configuration.ts` uses). */
const DEFAULT_APP_URL = 'http://localhost:3535';

export const EMAIL_MODULE_OPTIONS: EmailModuleOptions = {
  appName: APP_NAME,
  appUrl: () => process.env.APP_URL || DEFAULT_APP_URL,
  layout: {
    theme: { colors: { brand: THEME_COLOR } },
    brandMark: emailBrandMark(),
  },
  classifyRateLimit,
  sesRegionFallback: () => process.env.S3_REGION || undefined,
};
