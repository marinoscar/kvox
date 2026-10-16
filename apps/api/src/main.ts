// IMPORTANT: Load instrumentation before anything else
import './instrumentation';
// Registers the settings namespaces the DTOs below are composed from. Must stay
// the first import after instrumentation (see kvox.manifest.ts).
import './kvox.manifest';
// Fills core's role, permission, user-owned-model and model-ownership registries
// (#465). Before anything that reads them (the guards, the seed catalog, the
// OpenAPI RBAC docs); the registries freeze when the application bootstraps.
import './app-registrations/registrations';

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyEncryptionKeyAtStartup } from '@marinoscar/platform-api/core';
import { verifyTenancyModeAtStartup } from '@marinoscar/platform-api/identity';
import fastifyCookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { registerPlatformDocs } from '@marinoscar/platform-api/host';
import { simpleUploadFileSizeLimit } from '@marinoscar/platform-api/storage';
import { installManagedDeleteHook } from './kvox-objects/managed-delete.hook';
import { APP_OPENAPI } from './openapi/document';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Safety check: prevent test auth module in production
  if (process.env.NODE_ENV === 'production' && process.env.TEST_AUTH_ENABLED === 'true') {
    throw new Error('TEST_AUTH_ENABLED must not be true in production');
  }

  // `TENANCY_MODE` (#465): parsed and logged once, BEFORE the application
  // exists, so a typo never opens a database connection. Unset is `single`, the
  // only mode this app runs in.
  verifyTenancyModeAtStartup(process.env, logger);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  // SECRETS_ENCRYPTION_KEY validation (#116, epic #108).
  //
  // HERE, and not later: this runs before the Fastify plugins and before
  // `app.listen`, so a deployment that cannot read its own stored credentials
  // never binds the port and never serves a request. The whole point of the
  // issue is that this failure belongs in the deploy log rather than in a 500
  // handed to the first administrator who opens a settings page.
  //
  // AFTER `NestFactory.create`, and not before, because the check is not a pure
  // environment check: it asks the database whether any credential is actually
  // stored, and PrismaService only exists (and is only connected, via its
  // onModuleInit) once the container is up. That question is what lets this be
  // strict about the state that matters without breaking every deployment and
  // the `Smoke (boot compiled API)` CI job, neither of which sets the variable.
  // The full reasoning — including why there is no development fallback key and
  // no NODE_ENV branch — is in the header of core's encryption-key-startup-check
  // (`@marinoscar/platform-api/core`, adopted by #466).
  //
  // Throwing rather than exiting explicitly, matching the TEST_AUTH_ENABLED
  // guard above: `bootstrap()` is called unhandled at the bottom of this file,
  // so a rejection is an uncaught exception and Node exits non-zero with the
  // message on stderr. Not calling `app.close()` first is deliberate — the
  // process is about to die and the OS reclaims the connection, so closing
  // would only add a way for a shutdown hang to swallow the diagnosis.
  await verifyEncryptionKeyAtStartup(
    () => app.get(PrismaService).credential.count(),
    logger,
  );

  // Register cookie plugin
  await app.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET,
  });

  // Register multipart plugin for file uploads. The simple-upload route is the
  // platform's (`POST /api/storage/objects`); `simpleUploadFileSizeLimit` is the
  // limit the slice documents for it: min(100 MiB, the deployment's
  // `storage.maxFileSize`). Larger files take the resumable path.
  await app.register(multipart, {
    limits: {
      fileSize: simpleUploadFileSizeLimit(app.get(ConfigService).get('storage.maxFileSize')),
      files: 1,
    },
  });

  // Global prefix for all routes
  app.setGlobalPrefix('api');

  // Permanent until the platform adds a veto seam: the platform's
  // `DELETE /api/storage/objects/:id` has no seam for module ownership, so this
  // `onRequest` hook answers 409 `managed_by_module` for an object a domain
  // module owns, before the handler runs. It also forwards
  // `DELETE .../:id/upload/abort` of a managed object to the app's own abort
  // route (the platform abort deletes the row the owning record restricts).
  // After `setGlobalPrefix` because it matches the prefixed path.
  installManagedDeleteHook(app);

  // Enable CORS (same-origin by default, configurable)
  app.enableCors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  });

  // OpenAPI: the document and the two routes that serve it (`/api/docs` and
  // `/api/openapi.json`), both built by the platform host slice from
  // `APP_OPENAPI` (`openapi/document.ts`); `scripts/dump-openapi.ts` builds the
  // same document, so the one CI lints is the one users get.
  //
  // Registered AFTER `setGlobalPrefix('api')` above, because the introspection
  // reads the prefix off the application; the dump script sets the same prefix
  // for the same reason.
  //
  // `registerPlatformDocs` degrades rather than throws: generation is the widest
  // failure surface in this function, and it runs before the port is bound, so an
  // unguarded throw would make a documentation defect a total outage. It logs at
  // `error` and serves 503s on both docs paths instead; `openapi:dump` in CI
  // still fails the build on a document that cannot be generated.
  const docsReady = registerPlatformDocs(app, APP_OPENAPI, logger);

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`Application running on port ${port}`);
  logger.log(
    docsReady
      ? 'API reference available at /api/docs'
      : 'API reference DEGRADED: /api/docs and /api/openapi.json return 503 (see error above)',
  );
}

bootstrap();
