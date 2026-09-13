import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { EmailSettingsController } from './email-settings.controller';
import { EmailSettingsService } from './email-settings.service';
import { EmailTestSendService } from './email-test-send.service';
import { SesEmailProvider } from './providers/ses-email.provider';
import { SmtpEmailProvider } from './providers/smtp-email.provider';

// =============================================================================
// EmailModule (issue #122, epic #109)
// =============================================================================
//
// The transport layer, plus (as of #124) the admin surface over it. #123
// added templates; #125 adds the dispatcher that decides which provider to use
// for which event.
//
// #122 SHIPPED NO CONTROLLER, on the grounds that adding an HTTP surface
// before there is something to expose puts a route to review in
// infrastructure rather than in the diff that needs it. #124 is that diff:
// `EmailSettingsController` is the admin settings page's three operations, all
// gated on `system_settings:read`/`:write`, reviewed here where they are the
// point rather than buried in shared plumbing.
//
// THAT CONTROLLER RETURNS NO SECRET. The SMTP password reaches this module
// only as a write -- request body -> `EmailSettingsService.update` ->
// `CredentialsService.setSecret` -- and the read side uses `describe`, whose
// return type carries a compile-time proof that it has no field able to hold
// secret material. `CredentialsService.getSecret`, the plaintext one, is
// called from exactly one place in this module: `SmtpEmailProvider`, at the
// moment it opens a connection.
//
// BOTH PROVIDERS ARE REGISTERED UNCONDITIONALLY, not chosen here from the
// configured `provider` setting. Provider selection is a per-send, runtime
// decision: the setting lives in the database and an admin can change it
// without a restart, so a module-construction-time choice would be stale the
// moment they did. Both classes are cheap to instantiate -- neither opens a
// socket or reads a credential until its first send -- so registering both and
// letting #125 pick costs nothing and keeps the choice where it can respond to
// a settings change.
//
// NOT @Global(). SmtpEmailProvider depends transitively on
// `CredentialsService.getSecret`, which returns plaintext; the set of modules
// that can reach it should stay a list a person can read, which means every
// consumer writes `imports: [EmailModule]` and shows up in a diff.
// =============================================================================

@Module({
  imports: [
    // EmailSettingsService reads the `email` row of `system_settings`.
    PrismaModule,
    // The SMTP password. Imported explicitly (CredentialsModule is
    // deliberately not global) so this module's access to a plaintext-
    // returning service is visible right here.
    CredentialsModule,
  ],
  controllers: [EmailSettingsController],
  providers: [
    EmailSettingsService,
    // The test-send path (#124). Registered here rather than in a module of
    // its own because it is one method over the transports this module
    // already owns.
    EmailTestSendService,
    SesEmailProvider,
    SmtpEmailProvider,
  ],
  // EmailTestSendService is deliberately NOT exported: sending a test message
  // is an admin action reached through this module's controller, not a service
  // other features should be able to invoke. #125's dispatcher is the export
  // that real notifications will use.
  exports: [EmailSettingsService, SesEmailProvider, SmtpEmailProvider],
})
export class EmailModule {}
