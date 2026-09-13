// =============================================================================
// What an administrator may compose (issue #324, epic #319)
// =============================================================================
//
// The highest-consequence body this API accepts: everything validated here is
// rendered, unedited, into every active user's inbox and notification centre.
// So this file is deliberately strict, and every limit below is derived from a
// real downstream truncation point or a real transport budget rather than
// picked to look round.
//
// SHAPE FOLLOWS `jobs/dto/job-list-query.dto.ts`: a zod schema, exported so a
// service and a test can parse against it directly, plus a `createZodDto`
// class that is what reaches the global `ZodValidationPipe` and the OpenAPI
// document.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { NOTIFICATION_CHANNELS } from '../../notification-events';

/**
 * Title ceiling, chosen against `browser-notification.channel.ts`.
 *
 * That channel truncates a rendered title at `MAX_TITLE_LENGTH` (200) and
 * marks the cut with an ellipsis. 120 sits comfortably under it, so NOTHING AN
 * ADMIN TYPED IS EVER SILENTLY CUT — the composer refuses the 121st character
 * with a fixable 400 instead of accepting it and quietly dropping the tail in
 * one channel and not another. It is also about the length a mail client will
 * show of a subject line before eliding it, which is the same job this field
 * does in the email template.
 */
export const BROADCAST_TITLE_MAX = 120;

/**
 * Body ceiling, EXACTLY the browser channel's `MAX_BODY_LENGTH` (2000).
 *
 * Equal rather than lower on purpose: the channel's truncation is then
 * unreachable through this route, so the stored body and the delivered body
 * are the same string by construction. Combined with the title, the composed
 * text tops out at 2,120 characters, which plus the notification envelope
 * (event key, link, CTA label, metadata) fits inside a Web Push payload's
 * ~4 KB budget — a body past that budget is a push the browser's push service
 * rejects outright, which is a delivery failure with no message anywhere.
 */
export const BROADCAST_BODY_MAX = 2_000;

/** A button label, not a sentence. Long labels wrap and stop looking like buttons. */
export const BROADCAST_CTA_LABEL_MAX = 40;

/**
 * Link ceiling. Root-relative paths are short by nature; 500 is generous
 * enough for a path with query parameters and small enough that a link cannot
 * be used to smuggle a payload past the body limit.
 */
export const BROADCAST_LINK_MAX = 500;

/**
 * The characters `sanitizeLink` forbids: C0 controls, space, and DEL.
 *
 * Copied deliberately rather than imported, so this DTO does not reach into a
 * channel's internals — see the block on `link` below for why the rule is
 * stated in two places on purpose.
 */
const FORBIDDEN_LINK_CHARS = /[\u0000-\u0020\u007F]/;

/**
 * Root-relative link, validated with `sanitizeLink`'s exact allowlist.
 *
 * TWO PLACES CHECK THIS, AND THAT IS THE DESIGN. `sanitizeLink`
 * (`browser-notification.channel.ts`) is the SECURITY BOUNDARY: it runs on
 * every rendered notification, cannot be bypassed, and DROPS a bad link
 * silently because refusing the whole notification would let a malformed link
 * silence a mandatory security alert. That behaviour is right there and wrong
 * here — an admin who pastes `https://example.com/status` into the composer
 * and gets a broadcast whose button quietly vanished has no way to find out
 * why. So this check exists to produce a FIXABLE 400 at compose time; it is
 * not, and must not be relied on as, the boundary.
 *
 *   accepted:  "/status", "/admin/settings?tab=broadcasts", "/x#frag"
 *   rejected:  "//evil.example/x"   protocol-relative — a full URL to a
 *                                   browser, and the classic bypass of a naive
 *                                   "starts with /" check
 *              "https://evil/x", "javascript:alert(1)", "data:…"
 *              "status"             relative to wherever the reader happens to
 *                                   be, so it resolves differently per page
 *              "/\\evil.example"    a backslash after the slash, which several
 *                                   browsers normalise to `/`
 *
 * Trimmed first, exactly as `sanitizeLink` does, so the value stored is the
 * value that function would return rather than one it would have to re-trim.
 */
const rootRelativeLink = z
  .string()
  .trim()
  .min(1, 'link must not be empty')
  .max(BROADCAST_LINK_MAX)
  .refine((value) => !FORBIDDEN_LINK_CHARS.test(value), {
    message: 'link must not contain spaces or control characters',
  })
  .refine((value) => value.startsWith('/'), {
    message: 'link must be root-relative and start with "/"',
  })
  .refine((value) => !value.startsWith('//'), {
    message: 'link must not be protocol-relative ("//…")',
  })
  .refine((value) => !value.startsWith('/\\'), {
    message: 'link must not start with "/\\"',
  });

export const createBroadcastSchema = z
  .object({
    /** Becomes both the email subject and the notification headline. */
    title: z.string().trim().min(1, 'title must not be empty').max(BROADCAST_TITLE_MAX),

    /**
     * Plain text. Never markup — every channel escapes it on render, so HTML
     * typed here reaches the recipient as literal characters.
     */
    body: z.string().trim().min(1, 'body must not be empty').max(BROADCAST_BODY_MAX),

    /** Optional destination for the call-to-action. See `rootRelativeLink`. */
    link: rootRelativeLink.optional(),

    /** Optional label for the call-to-action. Requires `link` — see below. */
    ctaLabel: z.string().trim().min(1).max(BROADCAST_CTA_LABEL_MAX).optional(),

    /**
     * The channels this send may use — a NARROWING of what the event declares,
     * never a widening of it (see `NotifyOptions`).
     *
     * Non-empty because an empty array is a broadcast that reaches nobody: the
     * dispatcher treats `[]` as "every channel muted", so it would be accepted,
     * queued, fanned out across every active user, and deliver nothing, while
     * every job row reports success. Duplicate-free because a repeated channel
     * says nothing the set does not already say and would make the stored
     * column disagree with the admin's own list.
     */
    channels: z
      .array(z.enum(NOTIFICATION_CHANNELS))
      .min(1, 'select at least one channel')
      .refine((value) => new Set(value).size === value.length, {
        message: 'channels must not contain duplicates',
      }),

    /**
     * When to send. Absent means immediately.
     *
     * AN ISO-8601 STRING PARSED INTO A `Date`, not `z.coerce.date()`. The
     * coercing form accepts anything `new Date()` does — including
     * `"next tuesday"`-shaped garbage that silently becomes `Invalid Date` —
     * and, more concretely here, IT CANNOT BE RENDERED INTO THE OPENAPI
     * DOCUMENT: `z.date()` has no JSON Schema representation, so a coerced
     * field makes `SwaggerModule.createDocument` throw and takes `/api/docs`
     * down with it. A string with `format: date-time` is both the honest
     * description of what arrives over HTTP and the thing a generated client
     * can be built from. Offsets are allowed, so a composer may send its own
     * local time rather than converting to UTC first.
     *
     * STRICTLY IN THE FUTURE: a past timestamp on a job's `scheduledFor` is
     * claimable on the very next poll, so accepting one would turn "I mistyped
     * the date" into an immediate send to every user with no confirmation step
     * in between.
     */
    scheduledFor: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .refine((value) => value.getTime() > Date.now(), {
        message: 'scheduledFor must be in the future',
      })
      .optional(),

    /**
     * Marks this as an important announcement.
     *
     * NOT AN EVENT KEY. The service derives `admin.broadcast_critical` from
     * this flag; the key is never accepted from a client, because accepting it
     * would let any caller with `broadcasts:write` pick an event whose
     * `mandatory: true` makes it unmuteable — or, worse, name an event that is
     * not a broadcast at all and borrow its template.
     */
    critical: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    // A label with nothing to point at. The email template drops a `ctaLabel`
    // that has no `ctaUrl`, so this would be accepted and then silently
    // discarded — the admin sees a button in the composer and none in the
    // mail.
    if (value.ctaLabel && !value.link) {
      ctx.addIssue({
        code: 'custom',
        path: ['ctaLabel'],
        message: 'ctaLabel requires link',
      });
    }

    // =====================================================================
    // A CRITICAL BROADCAST MUST INCLUDE THE `browser` CHANNEL
    // =====================================================================
    //
    // This is where issue #321's ruling is enforced, and it is the single
    // most important line in this file.
    //
    // The dispatcher DELIBERATELY permits narrowing a mandatory event —
    // `mandatory` binds the RECIPIENT (they may not mute it), not the
    // SENDER (who may still choose a medium). That is the right rule there,
    // and it leaves exactly one gap: an admin could send
    // `admin.broadcast_critical` over `['email']` alone.
    //
    // Why that gap matters: in this application the durable `notifications`
    // row IS the in-app delivery. It is written by the browser channel, it
    // is what the bell renders, and it is the only record a recipient can go
    // back and read. A critical announcement sent over email only leaves NO
    // IN-APP RECORD AT ALL — so a user who missed the mail, filed it, or
    // never had a working mailbox has no way to discover that a service
    // interruption or a security notice was ever issued. That is precisely
    // the failure `mandatory` exists to prevent, arriving through the sender's
    // door instead of the recipient's.
    //
    // HONESTLY: THIS IS THE POLICY, NOT THE MECHANISM. A future call site
    // that reaches `notifyNow('admin.broadcast_critical', …)` without passing
    // through this DTO can still narrow to email alone, and nothing here will
    // stop it. Making it a mechanism would mean special-casing `mandatory` in
    // the dispatcher's intersection — which is exactly the coupling #321
    // rejected, because it puts a per-send decision inside the gate that
    // decides whether a user may mute an event at all. The API is the right
    // place for a policy about what an ADMIN may compose.
    if (value.critical && !value.channels.includes('browser')) {
      ctx.addIssue({
        code: 'custom',
        path: ['channels'],
        message:
          'a critical broadcast must include the "browser" channel: the durable in-app ' +
          'notification is the only record a recipient can go back and read',
      });
    }
  });

export class CreateBroadcastDto extends createZodDto(createBroadcastSchema) {}

/** The parsed, defaulted shape `BroadcastsService` consumes. */
export type CreateBroadcastInput = z.output<typeof createBroadcastSchema>;

/**
 * `POST /test` takes the same body as `POST /` and means something different
 * by it: compose this, send it to me, store nothing.
 *
 * The same schema rather than a looser one on purpose — a test send whose
 * validation differs from the real one tests the wrong composition, which is
 * the only thing a test send is for. `scheduledFor` is accepted and IGNORED
 * (a test send has no schedule); refusing it would make "compose, test, then
 * schedule" fail on a field the admin had already filled in correctly.
 */
export class TestBroadcastDto extends createZodDto(createBroadcastSchema) {}
