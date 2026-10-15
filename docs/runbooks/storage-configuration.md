# Runbook: Configure Object Storage

This runbook covers where the application's object storage (an S3 bucket, a
Cloudflare R2 bucket or an S3-compatible server) is configured, how to move an
existing deployment onto that configuration, and the rules an operator must
follow afterwards. It does not cover the bucket's CORS rule, which is its own
runbook: [`s3-cors.md`](s3-cors.md).

Object storage holds uploads (transcript audio, note sources), avatars,
transcript renditions and exports, note and graph exports, database backups and
the worker-node data plane. Nothing in the application works with uploads until
it is configured.

**The change, in one paragraph.** The bucket, region, endpoint and access keys
used to be environment variables read at startup. They are now runtime
configuration owned by the platform storage slice: an administrator enters them
at `/admin/settings/storage`, the non-secret fields are stored in the `storage`
system-settings namespace, and the secret access key is encrypted with
`SECRETS_ENCRYPTION_KEY` in the credential store. A change takes effect without
a restart. Until a configuration is saved, every route that needs the bucket
answers **503**.

Source of truth for every claim below:

- `apps/api/src/platform/storage/storage.config.ts`: how the slice is mounted
  and the stale-upload age.
- `apps/api/src/platform/storage/storage-key-prefix.manifest.ts`: every key
  prefix the deployment writes under.
- `apps/api/src/kvox-objects/`: the ownership table's service, the two extra
  multipart routes, the managed-object delete veto and the files list.
- `apps/api/src/config/configuration.ts`: the `storage` block, which still reads
  `MAX_FILE_SIZE`, `ALLOWED_MIME_TYPES`, `SIGNED_URL_EXPIRY` and
  `STORAGE_PART_SIZE`.
- `infra/compose/.env.example` and `infra/compose/base.compose.yml`: what is left
  in the environment.
- `docs/platform-adoption/local-exceptions.md`: the deliberate differences from
  the platform slice.

---

## 1. What moved, and what did not

| Was an environment variable | Now |
|---|---|
| `STORAGE_PROVIDER` | The **provider** radio on the storage page (Amazon S3, Cloudflare R2, S3-compatible). |
| `S3_BUCKET` | **Bucket** on the storage page. |
| `S3_REGION` | **Region** on the storage page. |
| `S3_ENDPOINT` | **Endpoint** (S3-compatible only; R2 derives it from the account id). |
| `AWS_ACCESS_KEY_ID` | **Access key ID** on the storage page. Not secret. |
| `AWS_SECRET_ACCESS_KEY` | **Secret access key** on the storage page. Stored encrypted, never displayed again. |
| `STORAGE_STALE_UPLOAD_HOURS` | Fixed at **72 hours** in code (`STALE_UPLOAD_HOURS`). There is no setting. |

Still environment variables, unchanged in meaning except where §5 says so:

| Variable | Meaning |
|---|---|
| `STORAGE_CSP_ORIGIN` | The browser-visible origin of the bucket, written into nginx's Content Security Policy. **No longer derived**; see §3 step 1. |
| `STORAGE_PART_SIZE` | The deployment-wide multipart part size. See §5. |
| `MAX_FILE_SIZE` | Largest upload accepted (answers 413 above it). |
| `ALLOWED_MIME_TYPES` | Content-type allowlist (answers 415 outside it). **Keep `audio/*` and `video/*` in it**: transcript uploads pass the application's own audio and video check and then the platform's init checks this list too, so a deployment that omits them rejects every transcript upload. |
| `SIGNED_URL_EXPIRY` | Lifetime of a signed upload or download URL, in seconds. |

Amazon SES email is the one remaining reader of AWS credentials in the
environment: until email moves to its own settings, the SES sender reads
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `S3_REGION` from the API
container's environment. A deployment that sends through SES keeps those three
variables in its `.env` by hand even though `.env.example` no longer lists them.
They have nothing to do with the bucket.

## 2. What the credential needs

Create the access key before the maintenance window. For an S3 bucket, a policy
on the bucket and its objects that allows:

| Action | Used for |
|---|---|
| `s3:PutObject` | Simple uploads, every multipart part, and starting a multipart upload. |
| `s3:GetObject` | Downloads and playback. |
| `s3:DeleteObject` | Deleting objects, and the connection test's throwaway object. |
| `s3:AbortMultipartUpload` | Aborting and sweeping unfinished uploads. |
| `s3:ListMultipartUploadParts` | **Listing the parts of an in-progress upload.** The application's `GET /api/storage/objects/{id}/upload/parts` calls S3 `ListParts`, and a browser cannot read part ETags itself, so a missing grant makes every large upload fail at the last step (502 from that route). |
| `s3:ListBucket` | Listing a prefix: the storage purge and the bucket checks. |

The **Create bucket** button on the storage page additionally needs
`s3:CreateBucket`, `s3:PutBucketPublicAccessBlock`,
`s3:PutEncryptionConfiguration` and `s3:PutBucketCORS`. Skip it if the bucket
already exists.

## 3. Moving an existing deployment

Do all of this inside one maintenance window
([`maintenance-mode.md`](maintenance-mode.md)). Between the deploy and the save
in step 4, every upload answers **503** with `details.reason:
"storage_not_configured"` and a `remedy` naming `/admin/settings/storage`;
downloads of existing objects fail the same way. Nothing else is affected.

**Step 0: record the current configuration, before deploying.** The deploy
removes the variables from `.env.example`, and a rebuilt `.env` will not carry
them. From the running deployment's `.env` write down:

- the bucket name (`S3_BUCKET`),
- the region (`S3_REGION`),
- the endpoint, if any (`S3_ENDPOINT`: MinIO, Wasabi, Backblaze B2 or similar),
- the access key id and secret access key (`AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`),
- the current `STORAGE_CSP_ORIGIN`, **or, if it is empty, the origin it was
  being derived to** (see step 1).

Keep the secret in your password manager, not in a ticket. The existing objects
stay where they are: the new configuration must name the **same** bucket.

**Step 1: set `STORAGE_CSP_ORIGIN` explicitly.** Before this change nginx
derived it from `S3_BUCKET` and `S3_REGION` when it was empty. The bucket is
runtime configuration now and nginx has already started by the time it is saved,
so nothing derives it any more. If you leave it empty the policy reads
`connect-src 'self'`, and the browser blocks every part upload and every
playback with an opaque status-0 error even though the API and the bucket are
fine. Set it in `infra/compose/.env` to the origin the signed URLs point at:

| Bucket | `STORAGE_CSP_ORIGIN` |
|---|---|
| AWS, DNS-compatible name | `https://<bucket>.s3.<region>.amazonaws.com` |
| AWS, name containing dots | `https://s3.<region>.amazonaws.com` (path-style) |
| MinIO, LocalStack, any custom endpoint | the endpoint's origin, for example `http://localhost:9000` |
| Behind a CDN or custom domain | that domain's origin |

Never a wildcard. Nginx renders the policy only when its container starts, so
recreate it after changing the value (the exact command is in
[`s3-cors.md`](s3-cors.md) under "Applying the fix").

**Step 2: deploy.** The migration moves the `managed_by` marker into the
`kvox_object_ownership` table and drops `storage_objects.managed_by` and
`storage_objects.part_size`. It needs no storage configuration. Existing
objects, transcripts and notes are untouched.

**Step 3: confirm the 503.** `GET /api/storage/status` (as any signed-in user
with `storage:read`) reports storage as not configured. This is the expected
state until step 4.

**Step 4: enter the configuration.** Sign in as an administrator (the
`storage_config:read` and `storage_config:write` permissions are admin only) and
open `/admin/settings/storage`.

1. Choose the provider and enter the bucket, region, endpoint (S3-compatible
   only) and access key id from step 0.
2. Paste the secret access key. Blank means "keep the stored secret", so on a
   first save it is required.
3. Press **Test**. It runs four checks and reports each separately: credentials
   accepted; bucket exists and is reachable; write, read back and delete one
   throwaway object under `storage-config-test/`; and a presigned URL that is
   valid and serves the object. Fix anything that fails before saving. A key
   missing `s3:DeleteObject` fails the round trip.
4. Press **Save**. The change is live immediately on every instance, with no
   restart; an instance may serve the previous answer for a few seconds.

Saving the same bucket the objects already live in is not a relocation. Saving a
**different** bucket, endpoint or provider while objects or backups still point
at the old one is refused with a 409 until you type the confirmation the page
asks for; confirming acknowledges that those objects are not copied.

**Step 5: verify.**

- `GET /api/storage/status` reports storage as configured.
- Upload a small file (Files view or a new transcript) and download it.
- Resume a large upload: start a file of at least 150 MB (more than ten parts at
  the default part size), reload the page part-way, and confirm it resumes and
  completes. This exercises the application's own part-signing and part-listing
  routes (§6).
- Play back an existing recording. If the browser console names the Content
  Security Policy, revisit step 1; if it names CORS, see
  [`s3-cors.md`](s3-cors.md).

**Step 6: clean up.** Remove `STORAGE_PROVIDER`, `S3_BUCKET`, `S3_ENDPOINT`,
`STORAGE_STALE_UPLOAD_HOURS` and, unless SES uses them (§1), `S3_REGION`,
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from `.env`. They are ignored,
and leaving a live secret in a file that nothing reads is only a liability.

## 4. A fresh install

`kvox deploy install` no longer asks for a bucket. Install as usual, set
`STORAGE_CSP_ORIGIN` in `.env` if you know the bucket's origin (step 1 above;
recreate nginx if you set it later), sign in as the initial administrator, and
complete step 4. Uploads answer 503 until you do. The CLI's `--purge-storage`
uninstall option still reads the five old variables from the deployment's
`.env`; see [`apps/cli/README.md`](../../apps/cli/README.md).

## 5. The part-size operator rule

Every multipart upload is sliced at one **deployment-wide** part size, from
`STORAGE_PART_SIZE` (default 10 MiB, minimum 5 MiB, S3's own floor). The old
adaptive sizing, which grew the part size with the file and saved the choice on
each upload, is gone, so nothing records a size per upload any more. Two rules
follow.

**Never change `STORAGE_PART_SIZE` while uploads are in flight.** A part already
on the bucket keeps the size it was uploaded with. If the value changes, a
resumed upload lays its remaining parts out at the new size, the part numbers no
longer line up, and the object is completed corrupt (or the completion fails).
Before changing it, drain or abort every in-flight upload: wait for them to
finish, ask users to cancel, or let the stale-upload sweep reclaim abandoned
ones (72 hours untouched). The value is read at startup, so the change also
needs a restart; do both in a quiet window.

**Check the 10,000-part ceiling.** S3 allows at most 10,000 parts per upload,
so one part size caps the largest object at `part size x 10,000`:

| `STORAGE_PART_SIZE` | Largest object |
|---|---|
| 10 MiB (default) | about 97.6 GiB |
| 64 MiB | about 625 GiB |
| 100 MiB | about 977 GiB |

The default carries `MAX_FILE_SIZE` (10 GiB) and the largest transcription
provider limit (5 GiB) with a wide margin: 10 GiB is 1,024 parts. If you raise
`MAX_FILE_SIZE` past the ceiling, raise the part size first, before any upload
starts, and keep both rules above. An upload larger than the ceiling is refused
at start with a 400 rather than failing late.

## 6. Large uploads: the two application routes

The platform's upload start signs only the first ten parts, and its storage
provider cannot list the parts of an upload. A multi-GB upload (hundreds of
parts) needs both, so the application adds two routes on the same path prefix.
They are the reason the credential needs `s3:ListMultipartUploadParts` (§2).

| Route | Purpose |
|---|---|
| `POST /api/storage/objects/{id}/upload/parts` | Signs the next batch of part URLs (up to 100). |
| `GET /api/storage/objects/{id}/upload/parts` | Lists the parts the bucket holds, as `{ partNumber, etag, size }`. The browser passes that list to the platform's `POST .../upload/complete`, and resumes from it. |

Both answer **404** (never 403) for an upload the caller did not start. The list
route answers **501** with `details.reason: "list_parts_unsupported"` when the
active driver is not in the S3 family, and **502**, with no provider text, when
the bucket cannot answer. API detail:
[`docs/API.md`](../API.md#storage-objects).

## 7. Aborted uploads and transcripts

A user who cancels a transcript upload in the app is handled at once: the
platform's abort would delete the object row, which the transcript holds with a
`Restrict` foreign key, so the application intercepts the cancel for any object
a module owns (a Fastify hook forwards it in-process to
`DELETE /api/storage/objects/:id/upload/abort-managed`), aborts the multipart
upload, keeps the row as `failed` and marks the transcript `failed` with
`failure_reason: "upload_aborted"`. A failed ownership lookup or forward answers
503 and the client can retry.

Everything else emits no event: an upload that goes quiet, or one the
72-hour stale-upload sweep reclaims. The `transcripts.housekeeping` job, which
runs every 10 minutes, finds transcripts still `uploading` whose source object
is aborted, gone, or older than the stale-upload age and marks them `failed`
(`upload_aborted`, at most 500 per run). **Those cases can take up to one
housekeeping cycle, about 10 minutes.** The following cycle purges the failed
row, since an upload that never completed has no audio to retry with. Nothing
needs doing; do not treat a transcript that is `uploading` for a few minutes
as stuck.

## 8. Rotating the key, or moving to another bucket

- **Rotate the access key**: open the page, paste the new secret, Test, Save.
  Old and new keys can overlap; revoke the old one afterwards.
- **Rotate `SECRETS_ENCRYPTION_KEY`**: follow
  [`rotate-secrets-encryption-key.md`](rotate-secrets-encryption-key.md). The
  storage secret is a row in the `credentials` table (purpose `storage`), so
  that rotation must re-encrypt it with the rest; until it does, **Test** and
  every upload fail with a decryption error.
- **Move to another bucket**: copy the objects first (`aws s3 sync`, `rclone`),
  keeping the keys byte-identical, then change the bucket on the page and
  confirm the 409. The application does not copy anything. Rows keep the bucket
  they were written to, which is why the page counts the objects and backups
  that would be stranded.

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Upload or download answers **503** `storage_not_configured` | No usable configuration. `details.missing` names the empty fields; the secret access key is the one that never displays as filled. Complete the page. |
| 503 `storage_bucket_unknown` | The process has not read a bucket yet: either none is saved, or the settings were unreadable at startup. Check the database is reachable; the settings re-read on the next storage call. |
| **Test** fails on credentials | Wrong key id or secret, or a key for a different account or endpoint. |
| **Test** fails on the bucket | Wrong name or region, or an endpoint that needs path-style addressing. |
| **Test** fails on the round trip | The key lacks `s3:PutObject`, `s3:GetObject` or `s3:DeleteObject` on `<bucket>/*`. |
| Upload stalls at 0%, console mentions Content Security Policy | `STORAGE_CSP_ORIGIN` is empty or wrong (§3 step 1). |
| Upload transfers, then fails at completion with a 502 on `.../upload/parts` | The key lacks `s3:ListMultipartUploadParts`. |
| Upload fails with a network error and no status, console mentions CORS | The bucket's CORS rule. See [`s3-cors.md`](s3-cors.md). |
| Playback does not start or seek | `Range` missing from the CORS rule, or `media-src` lacks the storage origin. |
| A resumed upload completes with a corrupt or wrong-size object | The part size changed while it was in flight (§5). Delete the object and upload again. |
| Transcript upload answers **415** at start although the file is audio or video | The platform's init checks `storage.allowedMimeTypes` (`ALLOWED_MIME_TYPES`, default `image/*,application/pdf,video/*,audio/*`) after the application's own pre-check. A deployment whose `ALLOWED_MIME_TYPES` omits `audio/*` or `video/*` rejects transcript uploads. Keep both in the list (§1). |
| Generic `DELETE /api/storage/objects/{id}` answers 409 `managed_by_module` | The object belongs to transcripts, notes or the graph. Delete it through the owning feature. |

## 10. Notes for operators

- **Managed objects are hidden from the application's file list, not from the
  platform route.** The web Files view lists through `GET /api/kvox/files`,
  which excludes objects a feature owns (a transcript's audio, a note's source
  document, a graph export). The platform's own `GET /api/storage/objects` still
  lists them for a caller who calls it directly. That discloses only the
  caller's **own** objects, and deleting one through the generic route is
  refused with 409, so this is accepted rather than closed.
- **Key layout.** Every prefix the deployment writes under is registered
  (`uploads/`, `avatars/`, `node-outputs/`, `database-backups/`, `transcripts/`,
  `notes/`, `graph/`), and destructive paths such as the storage purge may touch
  only registered prefixes. New generic uploads are written under
  `uploads/<organization id>/<timestamp>/`; objects written earlier keep their
  keys and are found through the database row, never by rebuilding a key.
- **Lifecycle rules.** If the bucket has a lifecycle rule that expires objects or
  incomplete multipart uploads, keep its window longer than the 72-hour
  stale-upload age so it never reclaims an upload the application still treats
  as live.

## 11. Rollback

Restore-based, because the migration drops two columns and a revert alone cannot
bring back `storage_objects.managed_by`:

1. Restore the pre-deploy database backup
   ([`database-restore.md`](database-restore.md)).
2. Redeploy the previous release.
3. Put the old variables (`STORAGE_PROVIDER`, `S3_BUCKET`, `S3_REGION`,
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `S3_ENDPOINT` if used) back
   into `.env`, from the values recorded in §3 step 0.

In development, rebuild the database from the migration history instead.
