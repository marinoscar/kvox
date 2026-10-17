# The kvox-api test host

The Prisma host the real-database specs of `@marinoscar/kvox-api` (`test/**/*.db.spec.ts`, Jest project `db`) run against. It exists so a slice that owns SQL can be proved on a real PostgreSQL with pgvector without the application: the platform schema and migrations from `@marinoscar/platform-db` plus the domain fragments and migrations from `@marinoscar/kvox-db`, composed the way a host with no domain history (KVox Desktop) composes them. Never published (`files` in the package lists `dist` only).

```bash
npm run test:host:prepare -w @marinoscar/kvox-api   # no database needed
npm run test:db -w @marinoscar/kvox-api             # needs PostgreSQL 16 with pgvector
```

`prepare.mjs` removes `prisma/` and `generated/` and rebuilds them: `platform db sync`, `platform db compose`, `kvox-db sync --names after-host` (the domain migrations are dated before the platform tables a fresh host installs, so they take host-relative names), `platform db compose` again, then `prisma generate` with the generator output pointed at `generated/` so this client never overwrites the application's. Both folders are git-ignored.

`db.ts` is what a spec imports:

```ts
const db = await createTestDb();       // a new database: vector and pg_trgm, every migration applied
const moduleRef = await Test.createTestingModule({
  imports: [createTestKvoxModule({ db }), MyModule.forRoot()],   // fakes for every port, KVOX_PRISMA = db.prisma
}).compile();
await db.dispose();                    // drops the database
```

The connection is `DATABASE_URL`, or `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD` (defaults `localhost`, `5432`, `postgres`, `postgres`); `POSTGRES_DB` names the maintenance database the new one is created from. The role needs `CREATEDB` and the right to create `vector` and `pg_trgm` (a superuser, as in CI). Create one database per spec file: a `migrate deploy` takes a few seconds.

The host is a plain superuser connection, so it does not exercise row-level security or the application's `NOBYPASSRLS` role; that stays the application's `*.db.spec.ts` tier.
