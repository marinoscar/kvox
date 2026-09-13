import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Database restored" template — `db_backup.restore_completed` (#288, #254)
// =============================================================================
//
// THE ONLY MANDATORY MESSAGE OF THE FOUR, and the reasoning is the one
// `role-changed.email.ts` makes about a privilege change: silence is itself
// the risk. The live database has just been replaced by the contents of an
// archive. Every write made after that archive was taken is gone. That is not
// a status update somebody may reasonably filter into a folder they read on
// Mondays, so — like the role change — this template says in its own footer
// that it cannot be switched off, because a mailbox has no other place to
// explain why it arrived.
//
// -----------------------------------------------------------------------------
// IT LEADS WITH DATA LOSS, NOT WITH SUCCESS
// -----------------------------------------------------------------------------
//
// "Restore completed successfully" is technically true and operationally
// useless: the reader's actual question is "what state is the application in
// now, and what is missing?". So the first paragraph names the archive's own
// timestamp and says plainly that anything written after it is not there.
//
// -----------------------------------------------------------------------------
// AND IT SAYS THE PROCESS EXITED
// -----------------------------------------------------------------------------
//
// The restore ends by exiting so a supervisor can start a process whose
// connection pool is built against the promoted database. A reader who sees a
// restart in their monitoring at the same minute as this email should be able
// to connect the two from the email alone, rather than opening an incident
// about an unexplained restart.
//
// No product name is hard-coded; `APP_NAME` is the only seam.
// =============================================================================

/** Everything the restore-completed message renders. */
export interface RestoreCompletedEmailData {
  /** The `database_backup_runs` row the archive came from. */
  runId: string;

  /**
   * When the SOURCE BACKUP was taken. THE MOST IMPORTANT VALUE IN THIS
   * MESSAGE: it is the cut-off after which data no longer exists. `null` only
   * when the row never recorded it.
   */
  backupTakenAt: Date | null;

  /** When the swap completed and the restored copy became live. UTC. */
  completedAt: Date;

  /**
   * The email address of whoever triggered the restore, or `null` for one
   * triggered without an actor.
   *
   * NAMED HERE, unlike in `role-changed.email.ts`, and the difference is the
   * reader. That message goes to somebody who may have just been demoted, and
   * naming the administrator discloses an identity into an adversarial read.
   * This one goes to operators who all already hold `db_backup:read`, about an
   * action taken on shared infrastructure, and "who did this?" is the first
   * question an incident review asks.
   */
  triggeredBy: string | null;

  /**
   * The pre-restore safety archive's run id, when one was taken, so the reader
   * knows there is a way back and what to name when asking for it. `null` when
   * the deployment's rollback mode retains the displaced database instead.
   */
  preRestoreBackupId: string | null;

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
 * Render the restore-completed message.
 */
export function restoreCompletedEmail(
  data: RestoreCompletedEmailData,
): RenderedEmail {
  const completedAt = formatTimestamp(data.completedAt);
  const takenAt =
    data.backupTakenAt === null
      ? 'Not recorded'
      : formatTimestamp(data.backupTakenAt);
  const triggeredBy = orNone(data.triggeredBy);
  const rollback =
    data.preRestoreBackupId === null
      ? 'The database displaced by this restore was retained; a rollback renames it back.'
      : `A safety backup was taken immediately before the swap (run ${data.preRestoreBackupId}).`;

  const subject = `${APP_NAME}: the database was restored from a backup`;

  const ctaUrl = data.appUrl ? `${data.appUrl}${DB_BACKUP_ADMIN_PATH}` : undefined;

  const rows: SafeHtml[] = [
    detailRow('Restored from run', data.runId),
    detailRow('Backup taken at', takenAt),
    detailRow('Restore completed', completedAt),
    detailRow('Triggered by', triggeredBy),
  ];

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      The database behind ${APP_NAME} has been <strong>replaced</strong> with
      the contents of a backup archive. The application is now serving the
      state it was in at <strong>${takenAt}</strong>; anything written after
      that point is <strong>not present</strong>.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
      ${rows}
    </table>
    <p style="margin:0 0 16px 0;">${rollback}</p>
    <p style="margin:0 0 16px 0;">
      The process that performed the restore exited immediately afterwards so a
      supervisor could start one with a connection pool built against the
      restored database. A restart at the time above is expected, not a
      separate incident.
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      You are receiving this because you can view database backups in
      ${APP_NAME}. This notification cannot be turned off, because a database
      being replaced should never be silent.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Database restored from a backup',
    // The preheader carries the cut-off, which is the one value that decides
    // whether the reader needs to act right now.
    previewText: `Now serving the state from ${takenAt}. Later data is not present.`,
    bodyHtml,
    ctaLabel: ctaUrl ? 'Open database backup' : undefined,
    ctaUrl,
  });

  const text = plainText({
    title: 'Database restored from a backup',
    lines: [
      `The database behind ${APP_NAME} has been REPLACED with the contents of a backup`,
      `archive. The application is now serving the state it was in at ${takenAt};`,
      'anything written after that point is NOT PRESENT.',
      '',
      `  Restored from run:  ${data.runId}`,
      `  Backup taken at:    ${takenAt}`,
      `  Restore completed:  ${completedAt}`,
      `  Triggered by:       ${triggeredBy}`,
      '',
      rollback,
      '',
      'The process that performed the restore exited immediately afterwards so a',
      'supervisor could start one with a connection pool built against the restored',
      'database. A restart at the time above is expected, not a separate incident.',
      '',
      `You are receiving this because you can view database backups in ${APP_NAME}.`,
      'This notification cannot be turned off, because a database being replaced',
      'should never be silent.',
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
