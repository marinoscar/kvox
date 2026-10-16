import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Database backup failed" template — `db_backup.backup_failed` (#288, #254)
// =============================================================================
//
// ONE TEMPLATE FOR TWO OUTCOMES, and the difference between them is carried in
// the payload rather than in a second file:
//
//   * `failed` — the run itself reported an error. Something observed it break
//     and wrote down what.
//   * `stale`  — the run stopped heartbeating and the ten-minute sweep gave up
//     on it. NOTHING observed it fail; the process executing it went away.
//
// They are the same message to the same audience about the same missing
// recovery point, and the only thing a reader does differently is where they
// go looking — so `outcome` selects one sentence and the rest is shared.
// Splitting them into two templates would duplicate the whole body to vary a
// clause, and duplicating a body is how two copies of one message drift.
//
// THE CONSEQUENCE IS STATED IN THE FIRST PARAGRAPH, deliberately. "A backup
// failed" is a status; "you have one fewer recovery point than you think, and
// nothing retries this before the next scheduled run" is the fact that decides
// whether the reader acts tonight or on Monday.
//
// No product name is hard-coded; `APP_NAME` is the only seam.
// =============================================================================

/** Which of the two give-up paths produced this message. */
export type BackupFailureOutcome = 'failed' | 'stale';

/** Everything the backup-failure message renders. */
export interface BackupFailedEmailData {
  /** The `database_backup_runs` row id. */
  runId: string;

  /** Which give-up path this was. See {@link BackupFailureOutcome}. */
  outcome: BackupFailureOutcome;

  /**
   * The recorded failure text. For a `stale` run this is the sweep's own
   * explanation rather than an error from the dump. `null` when nothing was
   * recorded at all.
   */
  error: string | null;

  /** When the run started, or `null` when the row never recorded it. */
  startedAt: Date | null;

  /** When the run was settled `failed` or `stale`. Rendered as UTC. */
  failedAt: Date;

  /** How the run was triggered, as stored (`scheduled`, `manual`, ...). */
  trigger: string | null;

  /** Absolute URL of the application root, for the CTA. Optional. */
  appUrl?: string;
}

/** Where the CTA points, appended to `appUrl`. Matches `adminSections.tsx`. */
const DB_BACKUP_ADMIN_PATH = '/admin/settings/db-backup';

/** ISO 8601 in UTC — matched against log lines, never against a wall clock. */
function formatTimestamp(value: Date): string {
  return value.toISOString();
}

/** `null` is a fact about the row, not a blank. Give it words. */
function orNone(value: string | null): string {
  return value === null || value.trim().length === 0 ? 'Not recorded' : value;
}

/** The one sentence that differs between the two outcomes. */
function outcomeSentence(outcome: BackupFailureOutcome): string {
  return outcome === 'stale'
    ? 'It stopped sending heartbeats and was given up on. Nothing observed it fail: the process executing it went away.'
    : 'It reported an error and was recorded as failed.';
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
 * Render the backup-failure message.
 */
export function backupFailedEmail(data: BackupFailedEmailData): RenderedEmail {
  const failedAt = formatTimestamp(data.failedAt);
  const startedAt =
    data.startedAt === null ? 'Not recorded' : formatTimestamp(data.startedAt);
  const error = orNone(data.error);
  const trigger = orNone(data.trigger);
  const sentence = outcomeSentence(data.outcome);

  const subject = `${APP_NAME}: database backup failed`;

  const ctaUrl = data.appUrl ? `${data.appUrl}${DB_BACKUP_ADMIN_PATH}` : undefined;

  const rows: SafeHtml[] = [
    detailRow('Run id', data.runId),
    detailRow('Outcome', data.outcome),
    detailRow('Triggered by', trigger),
    detailRow('Started at', startedAt),
    detailRow('Settled at', failedAt),
  ];

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      A database backup of ${APP_NAME} did not complete. ${sentence} This
      deployment now has <strong>one fewer recovery point</strong> than its
      retention policy assumes, and the run is
      <strong>not retried automatically</strong> — the next scheduled backup is
      the retry.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
      ${rows}
    </table>
    <p style="margin:0 0 8px 0;font-size:13px;line-height:20px;color:#4b5563;">
      Recorded reason:
    </p>
    <p
      style="margin:0 0 20px 0;padding:12px;background:#f3f4f6;border-radius:4px;font-family:monospace;font-size:13px;line-height:20px;color:#1f2937;word-break:break-word;"
    >
      ${error}
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      You are receiving this because you can view database backups in
      ${APP_NAME}.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Database backup failed',
    previewText: `Run ${data.runId} ended as ${data.outcome}: ${error}`,
    bodyHtml,
    ctaLabel: ctaUrl ? 'Open database backup' : undefined,
    ctaUrl,
  });

  const text = plainText({
    title: 'Database backup failed',
    lines: [
      `A database backup of ${APP_NAME} did not complete.`,
      sentence,
      '',
      'This deployment now has ONE FEWER RECOVERY POINT than its retention policy',
      'assumes, and the run is NOT retried automatically - the next scheduled backup',
      'is the retry.',
      '',
      `  Run id:        ${data.runId}`,
      `  Outcome:       ${data.outcome}`,
      `  Triggered by:  ${trigger}`,
      `  Started at:    ${startedAt}`,
      `  Settled at:    ${failedAt}`,
      '',
      'Recorded reason:',
      `  ${error}`,
      '',
      `You are receiving this because you can view database backups in ${APP_NAME}.`,
    ],
    ctaLabel: ctaUrl ? 'Open database backup' : undefined,
    ctaUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
