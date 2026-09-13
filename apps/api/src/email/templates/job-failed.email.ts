import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Background job failed" template — `jobs.job_failed` (issue #288, epic #254)
// =============================================================================
//
// THE FIRST OF FOUR OPERATIONAL TEMPLATES, and the one that sets the house
// style for the other three. Read the differences from the #128 templates
// as deliberate rather than as drift:
//
//   * THE READER IS AN OPERATOR, NOT A USER. Nobody's account has changed and
//     nothing is being asked of them personally. What they need is enough to
//     decide whether to go and look: WHAT failed, WHY, HOW MANY TIMES it was
//     tried, and WHEN it gave up. Reassurance ("you can safely ignore this")
//     would be actively wrong.
//
//   * IT SAYS "TERMINAL" IN WORDS. `jobs.job_failed` fires ONLY when the
//     attempt budget is spent or a rate limit has been hit past its ceiling —
//     never on a retry, never on a deferral. A reader who does not know that
//     will wait for a retry that is not coming, so the message states it.
//
//   * THE ERROR IS RENDERED VERBATIM AND ESCAPED. `lastError` is a message
//     from a handler this repository does not own; it can contain anything,
//     including markup. The `html` tagged literal escapes it by construction —
//     which is the whole reason every interpolation in this file goes through
//     that tag rather than through string concatenation.
//
// NO PRODUCT NAME IS HARD-CODED anywhere below. `APP_NAME` is the single seam
// (epic #254 success criterion 11); a fork renames the application in one
// place and every message follows.
// =============================================================================

/**
 * Everything the job-failure message renders.
 *
 * `failedAt` is PASSED IN rather than read from `new Date()` here, per the
 * rule the #128 templates set: a template that reads the clock is not a pure
 * function of its input, and "what exactly did we send?" stops being
 * answerable after the fact.
 */
export interface JobFailedEmailData {
  /** The job row's id, so a reader can find it in the admin list. */
  jobId: string;

  /** The registered handler type (`admin.broadcast.chunk`, ...). */
  jobType: string;

  /**
   * The last error the handler reported. `null` when the job was given up on
   * without one ever being recorded — rendered as an explicit phrase rather
   * than as a blank, for the same reason `role-changed.email.ts` spells out
   * "None" for an empty role list.
   */
  error: string | null;

  /** How many attempts were made before the give-up. */
  attempts: number;

  /**
   * Which side ran it — the in-process worker or a named worker node — or
   * `null` when the row never recorded one.
   */
  executor: string | null;

  /** When the job was settled `failed`. Rendered as UTC; see `formatTimestamp`. */
  failedAt: Date;

  /**
   * Absolute URL of the application root, for the CTA. Optional, as
   * everywhere else: with no `APP_URL` configured the layout omits the button
   * rather than rendering one that goes nowhere.
   */
  appUrl?: string;
}

/** Where the CTA points, appended to `appUrl`. Matches `adminSections.tsx`. */
const JOBS_ADMIN_PATH = '/admin/settings/jobs';

/**
 * ISO 8601, in UTC, with the `Z` left on — the same choice, for the same
 * reason, as every other template here: the server does not know the reader's
 * time zone, and this timestamp's job is to be matched against a log line.
 */
function formatTimestamp(value: Date): string {
  return value.toISOString();
}

/** `null` is a fact about the row, not a blank. Give it words. */
function orNone(value: string | null): string {
  return value === null || value.trim().length === 0 ? 'Not recorded' : value;
}

/** One row of the detail table. `value` is escaped by the `html` tag. */
function detailRow(label: string, value: string): SafeHtml {
  return html`<tr>
    <td
      style="padding:6px 16px 6px 0;font-size:14px;line-height:20px;color:#4b5563;white-space:nowrap;vertical-align:top;"
    >
      ${label}
    </td>
    <td style="padding:6px 0;font-size:14px;line-height:20px;color:#1f2937;vertical-align:top;">
      <strong>${value}</strong>
    </td>
  </tr>`;
}

/**
 * Render the job-failure message.
 */
export function jobFailedEmail(data: JobFailedEmailData): RenderedEmail {
  const timestamp = formatTimestamp(data.failedAt);
  const error = orNone(data.error);
  const executor = orNone(data.executor);

  const subject = `${APP_NAME}: background job "${data.jobType}" failed`;

  const ctaUrl = data.appUrl ? `${data.appUrl}${JOBS_ADMIN_PATH}` : undefined;

  const rows: SafeHtml[] = [
    detailRow('Job type', data.jobType),
    detailRow('Job id', data.jobId),
    detailRow('Attempts', String(data.attempts)),
    detailRow('Ran on', executor),
    detailRow('Failed at', timestamp),
  ];

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      A background job in ${APP_NAME} used up its retry budget and was given
      up on. It will <strong>not</strong> be retried automatically — the work
      it was doing has not been done.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
      ${rows}
    </table>
    <p style="margin:0 0 8px 0;font-size:13px;line-height:20px;color:#4b5563;">
      Last error reported by the handler:
    </p>
    <p
      style="margin:0 0 20px 0;padding:12px;background:#f3f4f6;border-radius:4px;font-family:monospace;font-size:13px;line-height:20px;color:#1f2937;word-break:break-word;"
    >
      ${error}
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      You are receiving this because you can view background jobs in
      ${APP_NAME}.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Background job failed',
    // The preheader carries the type and the error, so the inbox list alone
    // often answers "do I need to open this?".
    previewText: `${data.jobType} gave up after ${data.attempts} attempt(s): ${error}`,
    bodyHtml,
    ctaLabel: ctaUrl ? 'Open jobs' : undefined,
    ctaUrl,
  });

  const text = plainText({
    title: 'Background job failed',
    lines: [
      `A background job in ${APP_NAME} used up its retry budget and was given up on.`,
      'It will NOT be retried automatically - the work it was doing has not been done.',
      '',
      `  Job type:   ${data.jobType}`,
      `  Job id:     ${data.jobId}`,
      `  Attempts:   ${data.attempts}`,
      `  Ran on:     ${executor}`,
      `  Failed at:  ${timestamp}`,
      '',
      'Last error reported by the handler:',
      `  ${error}`,
      '',
      `You are receiving this because you can view background jobs in ${APP_NAME}.`,
    ],
    ctaLabel: ctaUrl ? 'Open jobs' : undefined,
    ctaUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
