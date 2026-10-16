import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EmailAttachment } from '../email.types';

// =============================================================================
// The one image this application ever puts in an email
// =============================================================================
//
// A single 96x96 PNG, committed to this repository, embedded as a CID part and
// rendered at 48x48 by `layout.ts`. It is the ONLY binary any outbound message
// carries, and `EmailMessage.attachments` is typed narrowly so it stays that
// way.
//
// -----------------------------------------------------------------------------
// TO REBRAND: REPLACE ONE FILE
// -----------------------------------------------------------------------------
//
//     apps/api/assets/email/logo.png
//
// That is the whole procedure. This repository is a template that gets renamed
// and re-skinned (see `scripts/rename.mjs` and `docs/RENAMING.md`), so the
// asset is a file on disk rather than bytes pasted into a `.ts` constant — a
// fork swaps a PNG with any tool it likes instead of regenerating a source
// file and re-reading a diff of base64.
//
// It is currently an exact 2x reduction of `apps/web/public/icons/icon-192.png`
// (the master `apps/web/scripts/generate-icons.py` writes from
// `packages/shared/identity.json`), reproduced by:
//
//     node apps/api/scripts/make-email-logo.mjs
//
// A replacement needs only to be a PNG. The layout states 48x48 in the markup,
// so a square image at 96x96 is the size that renders sharply on a retina
// display without paying for resolution nobody sees — and every byte here is
// base64-encoded into every copy of every message that carries it.
//
// -----------------------------------------------------------------------------
// WHY THE PATH IS `../../assets` AND WHY THERE IS NO BUILD STEP
// -----------------------------------------------------------------------------
//
// This is the same arrangement `src/export/pdf-fonts.ts` uses for the bundled
// Noto faces (issue #28), deliberately, and for the same reasons:
//
//   * `apps/api/assets` sits BESIDE `src` and `dist`, so
//     `<this file>/../../../assets/email` is `apps/api/assets/email` whether
//     this module is running from `src/email/templates` under ts-jest or from
//     `dist/email/templates` in production. No environment variable, no copy
//     step, no difference between the two.
//   * `npm run build` is `tsc -p tsconfig.build.json` — NOT `nest build` — so
//     `nest-cli.json`'s `assets` option would do nothing here even if it were
//     set. An asset that has to be copied into `dist` would need a build
//     script this project does not have.
//   * `apps/api/Dockerfile`'s production stage ALREADY carries
//     `COPY apps/api/assets ./apps/api/assets/`, added by #28 for the fonts,
//     and `test/transcripts/transcript-export-assets.spec.ts` already asserts
//     that line exists. Putting the logo under the directory that is already
//     copied and already guarded is why this feature needs no Dockerfile
//     change at all.
//
// ⚠ Do not move this file up or down a directory without changing the `..`
// count below. It is the one thing here that fails silently — in dev, where
// the file is always present anyway.
//
// -----------------------------------------------------------------------------
// A MISSING FILE IS NOT AN ERROR
// -----------------------------------------------------------------------------
//
// `emailLogoAttachment()` returns `null` rather than throwing when the asset
// cannot be read, and the layout falls back to the text wordmark it rendered
// before this existed. An image is the least important thing in a message: an
// invitation that arrives with a plain heading is a working invitation, and an
// invitation that was never sent because a PNG was missing from an image is
// not. Epic #109's rule — a notification failure never fails the action that
// triggered it — applies to the decoration inside one just as much.
//
// This is also the one file read in the templates layer, which is otherwise
// pure (see `email-template.types.ts`: "no Nest, no DI, no I/O"). The rule
// there is about not FETCHING THE DATA A MESSAGE RENDERS — a template that can
// query is a template that can fail and can be slow. Reading a committed build
// artefact once per process is the same category as `FONT_DIR`: a constant
// that happens to live beside the code instead of inside it.
// =============================================================================

/** `apps/api/assets/email`, from either `src/…` or `dist/…`. See the header. */
const EMAIL_ASSET_DIR = resolve(__dirname, '../../../assets/email');

/** The committed brand mark. One file, replaceable — see the header. */
const LOGO_FILE = resolve(EMAIL_ASSET_DIR, 'logo.png');

/**
 * The content id the layout writes into `src="cid:…"`.
 *
 * Product-neutral, for the same reason `PDF_FONTS`' aliases are
 * (`src/export/pdf-fonts.ts`): it is an internal handle no reader ever sees,
 * and `apps/cli/src/template-identity.test.ts` fails a rebrand that has to
 * touch identifiers. The `@` form is what RFC 2392 expects; the right-hand
 * side is a literal, not a real domain, and is never resolved by anything.
 */
export const EMAIL_LOGO_CID = 'brand-logo@email.local';

/** Rendered size, in CSS pixels. The asset is 2x this on each axis. */
export const EMAIL_LOGO_RENDERED_SIZE = 48;

/**
 * Memoised outcome of the one read. `undefined` = not attempted yet, `null` =
 * attempted and unavailable.
 *
 * Cached including the failure: a missing asset is a deployment-shaped
 * problem, not a transient one, so re-reading it on every message would buy
 * nothing and put a failing syscall in the send path of every notification.
 */
let cached: EmailAttachment | null | undefined;

/**
 * The brand logo, ready to embed — or `null` when the asset is unreadable.
 *
 * The returned object is the SAME object on every call and its `content`
 * buffer is shared; callers must not mutate either. Both transports only read
 * it (nodemailer base64-encodes it, `MailComposer` the same), and copying ~4 KB
 * per outbound message to defend against a mutation nobody performs would be
 * the wrong trade.
 */
export function emailLogoAttachment(): EmailAttachment | null {
  if (cached !== undefined) return cached;

  try {
    cached = {
      content: readFileSync(LOGO_FILE),
      cid: EMAIL_LOGO_CID,
      // The filename a client shows if it lists inline parts. Generic, so a
      // rebrand does not have to touch it.
      filename: 'logo.png',
      contentType: 'image/png',
    };
  } catch {
    // Deliberately silent, and deliberately not a `logger.warn`: this module
    // is plain functions with no Nest in it (see the header), and the caller
    // that notices is the layout, which simply renders the wordmark instead.
    cached = null;
  }

  return cached;
}

/**
 * Drop the memoised read. FOR TESTS ONLY.
 *
 * The no-logo branch of the layout is a real production path — an image built
 * before the `assets` copy existed, a fork that deleted the file — and a test
 * that could not reach it would leave that branch unexercised in the one
 * scenario it exists for.
 */
export function resetEmailLogoCacheForTests(): void {
  cached = undefined;
}

/** Where the asset lives, so a test can assert against the real file. */
export const EMAIL_LOGO_PATH = LOGO_FILE;
