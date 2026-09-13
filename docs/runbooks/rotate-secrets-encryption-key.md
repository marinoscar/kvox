# Runbook: Rotate `SECRETS_ENCRYPTION_KEY`

This runbook covers rotating the key that encrypts runtime-configured credentials
(the `credentials` table), and the separate, more serious situation of losing
that key entirely.

For the underlying cipher and key model, see
[`docs/SECURITY-ARCHITECTURE.md`, section 14](../SECURITY-ARCHITECTURE.md#14-encrypted-credential-storage-runtime-configured-secrets).
Source of truth for every claim below:

- `apps/api/src/common/crypto/secret-cipher.ts` — the cipher and key derivation.
- `apps/api/src/common/crypto/encryption-key-startup-check.ts` — boot-time validation.
- `apps/api/src/credentials/credentials.service.ts` — the store.

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
  approach is to freeze credential writes (block whatever admin surface calls
  `CredentialsService.setSecret`) for the duration.

- **Confirm you have the OLD key available too.** Rotation is a
  decrypt-with-old / re-encrypt-with-new operation. You need both keys
  available to the *same process* at the same time — see section 3 for why
  this is less trivial than it sounds.

## 2. What's safe with the app running, and what isn't

| Operation | Safe during rotation? |
|---|---|
| `CredentialsService.describe` / `.list` (reads that never touch `secret`) | Yes — unaffected by a rotation running elsewhere |
| Reading a credential via `getSecret` for existing, unrotated rows | Yes, as long as the app's configured key is still the OLD key |
| **Writing a new credential** (`setSecret`, from whatever future consumer calls it) | **No** — see section 4 |

Reads that never touch the ciphertext (`describe`, `list`) are always safe.
The dangerous operation is a **write** landing after your rotation script has
already read the table but before you've flipped the deployment's env var —
that new row is encrypted under the OLD key and your rotation script never
saw it. This is why a maintenance window or a write-freeze matters more than
read-availability during rotation.

## 3. The module-caching gotcha (read this before writing a script)

`secret-cipher.ts` resolves `SECRETS_ENCRYPTION_KEY` once and caches it in a
module-level variable (`cachedMasterKey`) for the life of the process; every
purpose's derived sub-key is likewise cached in a module-level `Map`
(`derivedKeyCache`). Neither cache has any invalidation path other than the
module being reloaded.

**Consequence**: inside a single running Node process, reassigning
`process.env.SECRETS_ENCRYPTION_KEY` after `secret-cipher.ts` has already
resolved a key has **zero effect** on that process. You cannot decrypt with
the old key, mutate the env var, and then encrypt with the new key in the
same `require`d instance of the module — it will keep using the key it
already cached.

The module's own comment names the fix, written for tests but equally the
literal mechanism for a rotation script:

> Use `jest.resetModules()` and re-`require` the module to exercise a
> different key.

Outside of Jest, the equivalent is deleting the module from `require.cache`
and re-requiring it:

```js
function loadCipherWithKey(key) {
  process.env.SECRETS_ENCRYPTION_KEY = key;
  const modulePath = require.resolve('../apps/api/dist/common/crypto/secret-cipher');
  delete require.cache[modulePath];
  return require(modulePath); // fresh module, fresh cachedMasterKey, fresh derivedKeyCache
}
```

(Adjust the path to wherever your script resolves the compiled — or
`ts-node`-loaded — module. The point is: a fresh `require`, not a fresh
`import` inside the same already-loaded module instance.)

## 4. The rotation procedure

Write this as a one-off Node/TypeScript script — for example, a Nest
"application context" script that constructs `PrismaService` directly, or a
small standalone script that opens its own Prisma client. It has five
phases. **Plaintext must never be logged or written to disk at any point** —
this is the same rule `secret-cipher.ts` itself is held to (it does not log
at all), and it applies equally to your script's own `console.log` calls.

**Phase A — decrypt everything under the OLD key.**
1. Set `SECRETS_ENCRYPTION_KEY` to the OLD key.
2. Load `secret-cipher.ts` fresh (section 3).
3. Read every row: `prisma.credential.findMany({ select: { id: true, purpose: true, name: true, secret: true } })`.
4. For each row, call `decryptSecret(row.secret, row.purpose)`.
5. Hold the decrypted plaintexts in memory only, keyed by row `id`. Do not
   write them anywhere.

**Phase B — invalidate the module cache.**
6. Delete the cipher module from `require.cache` so the next `require`
   resolves a fresh instance with empty `cachedMasterKey` / `derivedKeyCache`.

**Phase C — re-encrypt everything under the NEW key.**
7. Set `SECRETS_ENCRYPTION_KEY` to the NEW key.
8. Load `secret-cipher.ts` fresh again.
9. For each held plaintext, call `encryptSecret(plaintext, purpose)` (same
   `purpose` as the row it came from — the sub-key derivation is
   purpose-bound, so getting this wrong produces a ciphertext that fails to
   decrypt later even though nothing else went wrong).

**Phase D — write the new ciphertext back.**
10. For each row, `prisma.credential.update({ where: { id }, data: { secret: newCiphertext } })`,
    addressed by `id` (not by `purpose`/`name` upsert — you are updating an
    existing row, not creating one).
11. Discard the in-memory plaintexts once every row is confirmed rewritten.

**Phase E — cut the deployment over.**
12. Only after every row is confirmed rewritten, update the deployment's
    actual `SECRETS_ENCRYPTION_KEY` environment variable to the NEW key.
13. Restart the application normally. On boot,
    `verifyEncryptionKeyAtStartup` will validate the new key is
    well-formed and log that encrypted credential storage is available.
    Remember: **this check does not verify the key can decrypt existing
    rows** — it only counts them (see the decision table in
    `SECURITY-ARCHITECTURE.md` section 14). A row missed in step 3 (written
    after your read pass, still under the OLD key) will pass this boot check
    silently and only fail later, as an `InternalServerErrorException` from
    `CredentialsService.getSecret`, the first time something tries to read
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
for every affected row, logging that the credential "must be re-entered" and
returning a 500 to whatever internal caller tries to use it.

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

This repository currently has **no admin controller for credentials**
(`credentials.service.ts` deliberately has no HTTP layer — see its header
comment), so today this is necessarily a backend/database-level lookup, not
a UI flow. Two concrete options:

**(a) Programmatic access**, if you have a REPL or script with access to a
constructed `CredentialsService` (e.g. a Nest application-context script):
```ts
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
have them re-enter the secret through the normal write path once one exists
for that purpose.

## 6. Summary checklist

- [ ] New key generated with `openssl rand -base64 32` and stored outside the repo and the database
- [ ] Maintenance window scheduled or credential writes frozen
- [ ] Rotation script written per section 4, decrypting under OLD key and re-encrypting under NEW key in the same process, with an explicit module-cache reload between the two phases
- [ ] No plaintext logged or written to disk at any point
- [ ] All rows confirmed rewritten under the new key before the deployment's env var is changed
- [ ] Deployment's `SECRETS_ENCRYPTION_KEY` updated to the NEW key and app restarted
- [ ] Boot log confirms `SECRETS_ENCRYPTION_KEY is configured; encrypted credential storage is available.`
- [ ] Old key securely discarded once the app is confirmed healthy
