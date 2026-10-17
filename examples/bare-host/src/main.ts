import { startBareHost } from './bootstrap.js';
import { parseLeg } from './db.js';

// `node dist/main.js`: boot on a random loopback port and print it.
// BARE_HOST_DB picks the database (service | pglite); DATABASE_URL names the server of `service`.
async function main(): Promise<void> {
  const host = await startBareHost({
    leg: parseLeg(process.env.BARE_HOST_DB),
    port: process.env.PORT ? Number(process.env.PORT) : 0,
    log: (line) => console.log(line),
  });
  console.log(`BARE_HOST_URL=${host.baseUrl}`);

  const stop = (): void => {
    void host.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
