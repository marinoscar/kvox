# Runbook: Rotate `SECRETS_ENCRYPTION_KEY`

This runbook covers rotating the key that encrypts runtime-configured credentials
(the `credentials` table) and every user's own AI key (the platform's `user_ai_keys`
table), and the separate, more serious situation of losing that key entirely.

For the underlying cipher and key model, see
[`docs/SECURITY-ARCHITECTURE.md`, section 14](../SECURITY-ARCHITECTURE.md#14-encrypted-credential-storage-runtime-configured-secrets).
Source of truth for every claim below:

- `@marinoscar/platform-api/core` — the cipher and key derivation
  (`dist/core/crypto/secret-cipher.js` in the installed package) and the boot-time
  validation (`verifyEncryptionKeyAtStartup`, called from `apps/api/src/main.ts`).
- `@marinoscar/platform-api/credentials` — the store (`CredentialsService`),
  mounted by `apps/api/src/platform/credentials/credentials.config.ts`.
- `UserAiKeysService` in `@marinoscar/platform-api/ai` — the per-user AI keys, which use
  the same cipher with the purpose `'ai_user_key'`. (Until issue #477 the app kept them
  in its own `user_ai_credentials` table under the purpose `'ai-key'`; that table is
  dropped.)

Until issue #466 the cipher, the startup check and the store were the app's own files
(`common/crypto/`, `credentials/`). The packaged versions are byte-compatible with
them: the variable name, the sub-key label, the payload layout and the error texts are
unchanged, and existing ciphertext decrypts without a migration. That compatibility
was checked in both directions on existing ciphertext, so everything in this runbook
that describes the cipher still holds. What changed is where the code lives.

### Every table that holds ciphertext under this key

| Table | Sub-key domain (the `purpose` passed to the cipher) | Written by |
|---|---|---|
| `credentials` | the row's own `purpose` column (`smtp`, `push_vapid`, `transcription`, `storage`, ...) | `CredentialsService.setSecret` |
| `user_ai_keys` | the constant `'ai_user_key'` for every row (the platform AI slice; the rows written by the key migration of [ai-platform-migration.md](ai-platform-migration.md) are in it too) | the platform `UserAiKeysService` |
| `user_credentials`, `org_credentials` | `user:<userId>:<purpose>` and `org:<orgId>:<purpose>` | the platform's per-user and per-organization stores. Mounted but unused: this deployment writes no row, so both are empty. If one ever is not, rotate it too |

A rotation that rewrites only `credentials` leaves every user's AI key undecryptable
under the new key, and the boot check will not notice (section 4, Phase E).

**There is no shipped rotation script in this codebase.** Automatic
rotation/re-encryption tooling was scoped out of epic #108 as unnecessary at
this size — manual rotation, run by an operator as a one-off script, is
considered acceptable. This runbook describes how to write and run that
script safely, not a command you can copy-paste as-is.

---

## 1. Before you start

- **Generate the new key first**, so it exists before you need it:
  ```bash
  openssl rand -base64 32
  ```
  Store it in whatever secret manager or vault this deployment uses. Do not
  put it in a file inside this repository, and do not put it in the database.

- **Decide on a maintenance window.** Rotation has a real gap (see section 4)
  where a credential *written* during the rotation can be missed. The safest
  approach is to freeze credential writes for the duration: the admin surfaces that
  call `CredentialsService.setSecret` (email, push and transcription settings) and
  the users' AI key save route (`PUT /api/ai/keys/:provider`).

- **Confirm you have the OLD key available too.** Rotation is a
  decrypt-with-old / re-encrypt-with-new operation. You need both keys
  available to the *same process* at the same time — see section 3 for why
  this is less trivial than it sounds.

## 2. What's safe with the app running, and what isn't

| Operation | Safe during rotation? |
|---|---|
| `CredentialsService.describe` / `.list` (reads that never touch `secret`) | Yes — unaffected by a rotation running elsewhere |
| Reading a credential via `getSecret` for existing, unrotated rows | Yes, as long as the app's configured key is still the OLD key |
| **Writing a new credential** (`setSecret`, or saving an AI key through `PUT /api/ai/keys/:provider`) | **No** — see section 4 |

Reads that never touch the ciphertext (`describe`, `list`) are always safe.
The dangerous operation is a **write** landing after your rotation script has
already read the table but before you've flipped the deployment's env var —
that new row is encrypted under the OLD key and your rotation script never
saw it. This is why a maintenance window or a write-freeze matters more than
read-availability during rotation.

## 3. The module-caching gotcha (read this before writing a script)

The cipher module (`secret-cipher.js`, in the platform package) resolves
`SECRETS_ENCRYPTION_KEY` once and caches it in a
module-level variable (`cachedMasterKey`) for the life of the process; every
purpose's derived sub-key is likewise cached in a module-level `Map`
(`derivedKeyCache`). Neither cache has any invalidation path other than the
module being reloaded.

**Consequence**: inside a single running Node process, reassigning
`process.env.SECRETS_ENCRYPTION_KEY` after the cipher module has already
resolved a key has **zero effect** on that process. You cannot decrypt with
the old key, mutate the env var, and then encrypt with the new key in the
same `require`d instance of the module — it will keep using the key it
already cached.

A second trap since #466: `require('@marinoscar/platform-api/core')` returns an
index that re-exports `encryptSecret` and `decryptSecret` from the cipher module it
loaded first. Deleting the *index* from `require.cache` does not reload the cipher.
Load the cipher file itself, by absolute path.

The module's own comment names the fix, written for tests but equally the
literal mechanism for a rotation script:

> Use `jest.resetModules()` and re-`require` the module to exercise a
> different key.

Outside of Jest, the equivalent is deleting the module from `require.cache`
and re-requiring it:

```js
const path = require('node:path');

// The package's `exports` map does not expose the file, so locate the package
// root through its package.json and require the cipher by absolute path.
const packageRoot = path.dirname(require.resolve('@marinoscar/platform-api/package.json'));
const cipherPath = path.join(packageRoot, 'dist/core/crypto/secret-cipher.js');

function loadCipherWithKey(key) {
  process.env.SECRETS_ENCRYPTION_KEY = key;
  delete require.cache[cipherPath];
  return require(cipherPath); // fresh module, fresh cachedMasterKey, fresh derivedKeyCache
}
```

(Run it from `apps/api` or the repository root so the package resolves. The point
is: a fresh `require` of the cipher file, not a fresh `import` inside the same
already-loaded module instance. Loading a second key and then the first again, in
one process, and decrypting a sample ciphertext each time is a cheap self-test
before touching the database.)

## 4. The rotation procedure

Write this as a one-off Node/TypeScript script — for example, a Nest
"application context" script that constructs `PrismaService` directly, or a
small standalone script that opens its own Prisma client. It has five
phases. **Plaintext must never be logged or written to disk at any point** —
this is the same rule the cipher module itself is held to (it does not log
at all), and it applies equally to your script's own `console.log` calls.

**Phase A — decrypt everything under the OLD key.**
1. Set `SECRETS_ENCRYPTION_KEY` to the OLD key.
2. Load the cipher module fresh (section 3).
3. Read every row of every table in the list above:
   `prisma.credential.findMany({ select: { id: true, purpose: true, name: true, secret: true } })`
   and `prisma.userAiKey.findMany({ select: { id: true, secret: true } })`
   (and, should they ever hold rows, `user_credentials` and `org_credentials`).
4. For each `credentials` row, call `decryptSecret(row.secret, row.purpose)`. For each
   `user_ai_keys` row, call `decryptSecret(row.secret, 'ai_user_key')`.
5. Hold the decrypted plaintexts in memory only, keyed by row `id`. Do not
   write them anywhere.

**Phase B — invalidate the module cache.**
6. Delete the cipher module from `require.cache` so the next `require`
   resolves a fresh instance with empty `cachedMasterKey` / `derivedKeyCache`.

**Phase C — re-encrypt everything under the NEW key.**
7. Set `SECRETS_ENCRYPTION_KEY` to the NEW key.
8. Load the cipher module fresh again.
9. For each held plaintext, call `encryptSecret(plaintext, purpose)` (same
   `purpose` as the row it came from, `'ai_user_key'` for an AI key — the sub-key derivation is
   purpose-bound, so getting this wrong produces a ciphertext that fails to
   decrypt later even though nothing else went wrong).

**Phase D — write the new ciphertext back.**
10. For each row, `prisma.credential.update({ where: { id }, data: { secret: newCiphertext } })`
    (or `prisma.userAiKey.update(...)` for an AI key), addressed by `id` (not by
    `purpose`/`name` upsert — you are updating an existing row, not creating one).
    Write the `secret` column only, so `hint`, `label` and `updated_by_user_id` stay as they are.
11. Discard the in-memory plaintexts once every row is confirmed rewritten.

**Phase E — cut the deployment over.**
12. Only after every row is confirmed rewritten, update the deployment's
    actual `SECRETS_ENCRYPTION_KEY` environment variable to the NEW key.
13. Restart the application normally. On boot,
    `verifyEncryptionKeyAtStartup` (from `@marinoscar/platform-api/core`) will validate the new key is
    well-formed and log that encrypted credential storage is available.
    Remember: **this check does not verify the key can decrypt existing
    rows** — it only counts the `credentials` table (see the decision table in
    `SECURITY-ARCHITECTURE.md` section 14), and never looks at `user_ai_keys`.
    A row missed in step 3 (written
    after your read pass, still under the OLD key) will pass this boot check
    silently and only fail later: as an `InternalServerErrorException` from
    `CredentialsService.getSecret` for a `credentials` row, or as a failed decrypt in
    the AI key path for a `user_ai_keys` row, the first time something tries to read
    it. This is exactly why section 2's write-freeze / maintenance window
    matters — there is no safety net at boot for a row rotation missed.
14. Once you've confirmed the app is healthy against the new key, securely
    discard the old key from wherever it was staged for this rotation.

## 5. Key loss (not rotation gone wrong — the key is genuinely gone)

If the key protecting stored credentials is truly lost — not a rotation
interrupted mid-way, but the key itself is gone and unrecoverable — every row
encrypted under it is **permanently unreadable**. This is expected, correct
behavior of encryption at rest, not a bug: there is no backdoor and no
recovery path through the cipher. `CredentialsService.getSecret` will throw
for every affected `credentials` row, logging that the credential "must be re-entered" and
returning a 500 to whatever internal caller tries to use it. Every user's saved AI key
is lost the same way; each user re-saves their own on the AI settings page, and no
administrator can do it for them (the key is write-only and per user).

The only recovery is an administrator **re-entering** each affected
credential's secret from scratch. This is a normal `setSecret(purpose, name,
newPlaintext, meta)` call, providing a brand-new secret — it is not a
"restore," and there is nothing to restore it from.

### Finding which credentials need re-entering

`CredentialsService.describe` and `.list` never select the `secret` column,
so they keep working with no encryption key configured at all, or with a key
that cannot decrypt anything — `purpose`, `name`, `label`, `hint`, and the
timestamps remain fully readable regardless of key state. This makes them
(and the equivalent raw query) the correct tool for finding what needs
re-entry after key loss.

The platform's `CredentialsService` has **no HTTP controller**, and the app adds no
generic one (`credentials.config.ts` mounts the store only), so this is
necessarily a backend/database-level lookup, not a UI flow. The settings pages that
own a purpose (email, push, transcription) are the "normal write path" for re-entering it. Two concrete options:

**(a) Programmatic access**, if you have a REPL or script with access to a
constructed `CredentialsService` (e.g. a Nest application-context script):
```ts
// CredentialsService from '@marinoscar/platform-api/credentials'
const affected = await credentialsService.list('smtp'); // repeat per known purpose
// affected[i].purpose, .name, .label, .hint, .updatedAt are all populated;
// affected[i] has no field capable of holding the secret itself.
```

**(b) Direct SQL**, which needs no application code at all:
```sql
SELECT purpose, name, label, hint, updated_at
FROM credentials
ORDER BY purpose, name;
```
This query, like `describe`/`list`, never touches interpretation of the
`secret` bytes — it is safe to run regardless of whether the encryption key
is present, absent, or wrong.

Once you have that list, contact whoever owns each `purpose`/`name` pair and
have them re-enter the secret through the normal write path for that purpose (the
email, push or transcription settings page). For AI keys,
`SELECT user_id, provider, hint, updated_at FROM user_ai_keys` lists
who needs to re-save theirs.

## 6. Summary checklist

- [ ] New key generated with `openssl rand -base64 32` and stored outside the repo and the database
- [ ] Maintenance window scheduled or credential writes frozen
- [ ] Rotation script written per section 4, decrypting under OLD key and re-encrypting under NEW key in the same process, with an explicit module-cache reload of the cipher file between the two phases
- [ ] Every table in the list at the top is covered: `credentials` and `user_ai_keys` (and `user_credentials` / `org_credentials` if they hold rows)
- [ ] No plaintext logged or written to disk at any point
- [ ] All rows confirmed rewritten under the new key before the deployment's env var is changed
- [ ] Deployment's `SECRETS_ENCRYPTION_KEY` updated to the NEW key and app restarted
- [ ] Boot log confirms `SECRETS_ENCRYPTION_KEY is configured; encrypted credential storage is available.`
- [ ] Old key securely discarded once the app is confirmed healthy
