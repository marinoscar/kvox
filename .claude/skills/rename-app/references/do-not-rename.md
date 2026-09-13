# Identity strings that must never be renamed

These look like the template's name. They are not — each is a live identifier
that something outside this repository depends on. `scripts/rename.mjs` knows to
leave them alone; this file exists for the case where an agent or a person is
editing by hand.

**Never run a repo-wide case-insensitive find-and-replace on the template's
name.** That single action is the realistic way the first entry below gets
broken, and it is unrecoverable.

---

## 1. The HKDF subkey label — destroys data

**`apps/api/src/common/crypto/secret-cipher.ts`**

```
SUBKEY_LABEL_PREFIX = 'enterpriseappbase:secret-cipher:v1:'
```

This string is an input to the key-derivation function that encrypts every
credential stored through the application — SMTP passwords and anything else an
administrator has entered at runtime.

**Changing it changes the derived key, and every existing ciphertext in the
database becomes permanently undecryptable.** There is no recovery: the
plaintext is not stored anywhere else.

It is lowercase and unpunctuated, which is why a *case-sensitive* search for the
template's name never surfaces it — and why the identity guard test is
deliberately case-sensitive. A case-insensitive replace defeats that protection.

It is documented in `docs/SECURITY-ARCHITECTURE.md`, which must also keep the
literal verbatim.

Moving it is only possible alongside a re-encryption migration. That is not part
of a rebrand.

## 2. The cross-realm Symbol key

**`apps/api/src/common/exceptions/verbatim-error-body.exception.ts`** — a
`Symbol.for(...)` call whose key is built from the repository's name. Open the
file to see the exact literal; it is not quoted here, because this document is
itself scanned by the identity guard and quoting it would need an allowlist
entry that buys nothing.

`Symbol.for` looks up a key in a process-global registry. The string *is* the
identity; two modules agree only because they pass the identical literal.
Renaming it breaks that agreement silently — the exception stops being
recognised and error bodies change shape, with nothing failing loudly.

This file is on the identity guard's allowlist for exactly this reason.

## 3. The nginx vhost sentinel — breaks live servers

**`apps/cli/src/deploy/proxy.ts`**

```
# Managed by appctl deploy
```

This marker is **written into vhost files and then parsed back**. It is the
safety check that stops the CLI from overwriting a vhost a human wrote by hand.

Rename it and the CLI no longer recognises the files it wrote itself under the
old marker — it will refuse to manage them, and an operator has to edit servers
by hand to recover.

## 4. The deploy state filename — orphans deployments

**`apps/cli/src/deploy/state.ts`**

```
DEPLOY_STATE_FILENAME = '.appctl-deploy.json'
```

Read from live servers to discover what is currently deployed there. Renaming it
makes every existing deployment invisible to the CLI: `deploy status` reports
nothing, and `deploy update` behaves as though it were a first install.

If the binary is genuinely being renamed, this still stays put unless you also
plan a migration for machines already running it.

---

## Not identity at all

Leave these alone; they carry no product name and renaming them only creates
churn:

| What | Why |
|---|---|
| `@app/shared` | A workspace package scope. Generic already. |
| `api`, `web`, `nginx` service names | Docker Compose service keys, referenced across every overlay file and by nginx's upstreams. |
| `app-network`, `devnet`, volume names | Infrastructure names, already product-neutral. |
| `refresh_token` cookie name | A protocol detail, not branding. |
| `appdb` | The default database name — configured by `POSTGRES_DB`, not by identity. |

---

## The general rule

If you find an identity string the codemod missed, **add an anchor to
`scripts/rename.mjs`** so the next fork gets it for free. Hand-editing the file
fixes one rename and leaves the next one to rediscover the same gap.

If you are unsure whether something is identity or a live identifier, ask. The
cost of asking is a message; the cost of guessing wrong on entry 1 is every
stored credential in the database.
