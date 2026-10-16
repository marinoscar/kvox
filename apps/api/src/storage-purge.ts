/**
 * `npm run storage:purge`: the in-image half of `deploy uninstall --purge-storage`.
 *
 * The platform CLI runs this inside the api image because the bucket settings and
 * the encrypted access key live in the database, not in `.env`. All behaviour
 * (dry run by default, `--confirm --bucket <name>` to delete) is the platform's
 * `runStoragePurgeCli`; this file only boots the application context.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { runStoragePurgeCli } from '@marinoscar/platform-api/storage';
import { AppModule } from './app.module';

async function main(): Promise<number> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    return await runStoragePurgeCli(app, process.argv);
  } finally {
    await app.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
