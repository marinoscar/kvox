# Runbook: Configure Bucket CORS for Browser Uploads and Playback

This runbook covers one thing: the CORS rule your object-storage bucket needs
before a browser can upload a file to it or play one back from it. Without the
rule, uploads and playback fail in the browser while everything else — the API,
signed URL generation, the CLI, `curl` — keeps working perfectly, which is what
makes this one of the harder failures to read.

It is the bucket-side half of a pair. The browser-side half is the Content
Security Policy, which must name the same origin; see
[`infra/nginx/csp.conf`](../../infra/nginx/csp.conf) and the
`STORAGE_CSP_ORIGIN` variable in
[`infra/compose/.env.example`](../../infra/compose/.env.example). **Both are
required. Fixing one and not the other leaves the symptom unchanged.**

Source of truth for every claim below:

- `apps/api/src/storage/objects/objects.service.ts` — `initUpload`,
  `presignParts` and `completeUpload`; what the browser is actually asked to do.
- `apps/api/src/storage/providers/s3/s3-storage.provider.ts` — the presigned
  `UploadPart` / `GetObject` URLs, and `listParts`.
- `apps/api/src/config/configuration.ts` — the `storage.s3` block, read from
  `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT`.
- `infra/nginx/csp.conf` and `infra/nginx/csp.dev.conf` — `connect-src` and
  `media-src`.
- `infra/compose/base.compose.yml` — how `STORAGE_CSP_ORIGIN` reaches nginx.

---

## 1. Why the bucket has to be configured at all

Bytes never pass through this API. A resumable upload works like this:

1. The browser calls `POST /api/storage/objects/upload/init` and gets back a
   part size and a first batch of signed `PUT` URLs.
2. The browser **PUTs each part directly to the bucket**, cross-origin.
3. It asks `POST /api/storage/objects/{id}/upload/parts` for more signed URLs
   as it goes, and `GET /api/storage/objects/{id}/upload/status` for what the
   bucket already holds if it needs to resume.
4. It calls `POST /api/storage/objects/{id}/upload/complete`.

Step 2 is a cross-origin request from your application's origin to the bucket's
origin, so the browser applies CORS. Playback is the same story in reverse:
`<audio src="<signed URL>">` loads from the bucket, not from your app.

Routing the bytes through the API instead would remove the CORS requirement and
replace it with a worse problem — a multi-gigabyte upload occupying a Node
process for its entire duration, through a proxy, with the request body
buffered somewhere. The presigned URL exists precisely so that does not happen.

## 2. What the rule must allow

| Element | Value | Why |
|---|---|---|
| `AllowedMethods` | `PUT`, `GET`, `HEAD` | `PUT` uploads a part. `GET` downloads and plays back. `HEAD` is what the browser's media element and most resumable-upload libraries use to probe an object before fetching it. |
| `AllowedOrigins` | your application's origin | Exactly the origin the app is served from (`https://app.example.com`, or `http://localhost:3535` in development). Not the bucket's origin — the *page's*. |
| `AllowedHeaders` | at least `content-type`, and `Range` | See below. |
| `ExposeHeaders` | `ETag` — optional | Only needed if a client wants to send its own `parts` list to `/upload/complete`. Omitting the `parts` field entirely is the supported browser path and needs nothing exposed. |
| `MaxAgeSeconds` | `3000` | How long the browser may cache the preflight. Not load-bearing. |

Two of those rows are where deployments actually go wrong:

**`Range` must be allowed.** An `<audio>` element does not fetch a recording in
one shot — it issues ranged `GET`s to seek, and a user dragging the scrubber
issues more. If `Range` is not in `AllowedHeaders`, the preflight for the ranged
request fails and playback either refuses to start or refuses to seek, while a
plain download of the same object works. That asymmetry is the signature of this
mistake.

**`ETag` does not need to be exposed.** Completing a multipart upload needs each
part's ETag, and the ETag of a cross-origin `PUT` is unreadable from JavaScript
unless the bucket lists it in `ExposeHeaders`. Rather than depend on that, the
`parts` field of `POST /api/storage/objects/{id}/upload/complete` is optional:
omit it and the **server** reads the parts back from the provider with
`ListParts`. A browser client should always omit it. Expose `ETag` only if you
have a non-browser client that would rather not pay for the extra call.

## 3. The rule

Replace `https://app.example.com` with your application's origin. If you serve
the app from more than one origin, list each one — never `"*"`, which would let
any page on the internet read your objects with a URL it happened to obtain.

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "Range", "x-amz-*"],
    "ExposeHeaders": ["ETag", "Content-Range", "Accept-Ranges", "Content-Length"],
    "MaxAgeSeconds": 3000
  }
]
```

`x-amz-*` covers the headers the AWS SDK adds to a signed request. `Content-Range`
/ `Accept-Ranges` / `Content-Length` in `ExposeHeaders` are what let a media
element reason about a ranged response; they are cheap and worth including even
though playback often limps along without them.

### 3.1 AWS S3, with the CLI

Save the block above as `cors.json`, then:

```bash
aws s3api put-bucket-cors \
  --bucket "$S3_BUCKET" \
  --cors-configuration file://cors.json
```

Read it back — this is the fastest way to confirm you edited the bucket you
think you did:

```bash
aws s3api get-bucket-cors --bucket "$S3_BUCKET"
```

A bucket with no rule at all answers `NoSuchCORSConfiguration`, which is a
normal "nothing configured yet" and not an error to chase.

### 3.2 MinIO

MinIO accepts the same S3 API, so the `aws s3api` call above works against it
once the endpoint is pointed at MinIO:

```bash
aws --endpoint-url "$S3_ENDPOINT" s3api put-bucket-cors \
  --bucket "$S3_BUCKET" \
  --cors-configuration file://cors.json
```

With `mc` instead:

```bash
mc alias set local "$S3_ENDPOINT" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY"
mc cors set local/"$S3_BUCKET" cors.json
mc cors get local/"$S3_BUCKET"
```

⚠ Older MinIO releases ignore per-bucket CORS entirely and instead respond to
every origin by default, or are configured process-wide with
`MINIO_API_CORS_ALLOW_ORIGIN`. If `mc cors` is not a command your binary has,
that is which era you are on — set the environment variable on the MinIO
service and restart it:

```yaml
environment:
  MINIO_API_CORS_ALLOW_ORIGIN: http://localhost:3535
```

## 4. Verifying it

Send the preflight the browser would send, by hand. This needs no application
and no signed URL:

```bash
curl -i -X OPTIONS "$S3_ENDPOINT/$S3_BUCKET/probe" \
  -H "Origin: https://app.example.com" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: content-type"
```

A correctly configured bucket answers `200` with an
`Access-Control-Allow-Origin` header echoing your origin. A bucket with no
matching rule answers `403`, and the response body names `CORSResponse` — that
403 is the CORS rule refusing, not your credentials being wrong.

Repeat with `-H "Access-Control-Request-Headers: range"` to confirm the
playback half.

## 5. Troubleshooting

**Uploads fail with a network error and no status code.** The classic CORS
symptom: the browser refuses the request before it is sent, so there is no
response to inspect. Check the browser console for the actual reason — it names
whether the block came from CORS or from the Content Security Policy, and they
need different fixes (bucket rule vs. `STORAGE_CSP_ORIGIN`).

**The console says `Refused to connect to … because it violates the following
Content Security Policy directive: "connect-src 'self'"`.** This is *not* a
bucket problem. `STORAGE_CSP_ORIGIN` is unset (and not derivable — see below)
or wrong. Set it explicitly in `infra/compose/.env` to the bucket's origin and
recreate nginx (see "Applying the fix" below).

**Symptom, end to end: an upload sits at 0% and then every part reports "Part
N failed after 5 attempts" (or, on a build with the CSP-specific check, a
single error naming `STORAGE_CSP_ORIGIN` instead of five retries), zero parts
ever show up in the bucket, and the served policy reads `connect-src 'self'
;` with nothing after it.** Check the policy nginx is actually serving:

```bash
curl -s -D - -o /dev/null https://<host>/ | grep -i content-security-policy
```

If `connect-src` lists only `'self'`, `STORAGE_CSP_ORIGIN` was empty (or,
before this was fixed, simply unset by default) when nginx started.
`STORAGE_CSP_ORIGIN` now derives to the AWS virtual-hosted origin
(`https://<bucket>.s3.<region>.amazonaws.com`) automatically when it is left
empty and `S3_BUCKET`/`S3_REGION` are set for plain AWS S3 — see the comment
above `STORAGE_CSP_ORIGIN=` in `infra/compose/.env.example`. It still needs
setting **explicitly** for MinIO/LocalStack/any `S3_ENDPOINT`, a bucket name
containing dots, or a CDN/custom domain in front of the bucket — the derived
value is wrong or absent in each of those cases.

**Applying the fix.** Nginx renders `csp.conf`'s template with `envsubst`
**only once, at container start** — editing `.env` and sending nginx a reload
does nothing, because the rendered file on disk does not change. Recreate the
container instead:

```bash
docker compose -f base.compose.yml -f dev.compose.yml up -d --force-recreate nginx
```

Then re-run the `curl` check above to confirm `connect-src` now lists the
bucket's origin.

**Uploads work; playback does not.** `Range` is missing from `AllowedHeaders`,
or `media-src` is missing the storage origin. Both produce the same silent
failure of an `<audio>` element that never starts.

**Playback starts but seeking does nothing.** Ranged requests are being refused
while the initial unranged `GET` succeeds. Same fix: allow `Range`.

**It works in development and not in production.** The origins differ. The rule
names the *page's* origin, so `http://localhost:3535` being allowed says nothing
about `https://app.example.com`. Both need listing, or each environment needs
its own bucket.

**`curl` and the CLI can upload; the browser cannot.** Expected, and a useful
diagnosis rather than a contradiction: neither `curl` nor the CLI is a browser,
so neither performs a preflight or enforces CORS. If both work, the signed URLs
and the credentials behind them are fine and the problem is entirely in the
bucket's CORS rule or the page's CSP.

**A preflight succeeds but the `PUT` returns 403.** That is no longer CORS. The
signed URL has expired — part URLs are signed for `SIGNED_URL_EXPIRY` seconds
(one hour by default), and a multi-gigabyte upload outlives its own first batch.
A client is expected to ask `POST /api/storage/objects/{id}/upload/parts` for a
fresh batch as it goes; the `expiresAt` in that response is when to come back.
