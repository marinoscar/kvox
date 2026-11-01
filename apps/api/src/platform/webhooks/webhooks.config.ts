// =============================================================================
// The app's binding of the webhooks slice (#795)
// =============================================================================
//
// `@marinoscar/platform-api/webhooks`, configured for this app: the product name
// in the `User-Agent` and the host module that binds the bypass client. Every
// other option is the slice's default (20 consecutive failures open the circuit,
// 24 hours of secret overlap on a rotation, 30 days of delivery history, https
// only, no private targets). A deployment that must call an internal receiver
// sets `allowedHosts` here, never an environment variable. Imported once by
// `app.module.ts`.
// =============================================================================

import { WebhooksModule } from '@marinoscar/platform-api/webhooks';
import { APP_NAME } from '@app/shared';

import { WebhooksHostModule } from './webhooks-host.module';

export const webhooksModule = WebhooksModule.forRoot({
  appName: APP_NAME,
  imports: [WebhooksHostModule],
});
