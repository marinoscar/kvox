import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Worker node went offline" template — `nodes.node_offline` (#288, epic #254)
// =============================================================================
//
// THE FACT WORTH REPORTING IS LOST CAPACITY, NOT A CRASH. Nothing observed
// this node fail: the fleet sweep noticed that it stopped heartbeating past
// the stale window and wrote `offline`. That distinction drives the copy —
// the message says what was last heard and when, and does not assert a cause
// it cannot know.
//
// THE NODE'S NAME IS OPERATOR-SUPPLIED and reaches this template unvalidated,
// so it is interpolated through the `html` tag like every other value here and
// is escaped by construction.
//
// No product name is hard-coded; `APP_NAME` is the only seam.
// =============================================================================

/** Everything the node-offline message renders. */
export interface NodeOfflineEmailData {
  /** The node row's id. */
  nodeId: string;

  /** The operator-supplied display name. Escaped on the way into the html. */
  nodeName: string;

  /**
   * When the node was last heard from, or `null` when it registered and never
   * heartbeated at all — which is a genuinely different failure (a node that
   * came up and could not reach the control plane) and is worth saying so.
   */
  lastHeartbeatAt: Date | null;

  /** When the sweep marked it offline. Rendered as UTC. */
  markedOfflineAt: Date;

  /**
   * The stale window in minutes that the sweep applied, so the reader can tell
   * "unreachable for 6 minutes" from "unreachable for 6 hours" without going
   * to look up the policy.
   */
  staleAfterMinutes: number;

  /** Absolute URL of the application root, for the CTA. Optional. */
  appUrl?: string;
}

/** Where the CTA points, appended to `appUrl`. Matches `adminSections.tsx`. */
const WORKERS_ADMIN_PATH = '/admin/settings/workers';

/** ISO 8601 in UTC — matched against log lines, never against a wall clock. */
function formatTimestamp(value: Date): string {
  return value.toISOString();
}

/**
 * A never-heartbeated node gets WORDS rather than a blank cell.
 *
 * The same rule `role-changed.email.ts` applies to an empty role list: the
 * most alarming value in the message must not render as whitespace that reads
 * like a formatting bug.
 */
function formatHeartbeat(value: Date | null): string {
  return value === null
    ? 'Never — it registered and never sent a heartbeat'
    : formatTimestamp(value);
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
 * Render the node-offline message.
 */
export function nodeOfflineEmail(data: NodeOfflineEmailData): RenderedEmail {
  const heartbeat = formatHeartbeat(data.lastHeartbeatAt);
  const markedAt = formatTimestamp(data.markedOfflineAt);

  // The SUBJECT DELIBERATELY DOES NOT CARRY THE NODE NAME. Subject lines are
  // not HTML and are therefore not escaped by the `html` tag, so putting an
  // operator-supplied string in one would be the single place in this file
  // where an unescaped value reaches a rendered surface. The name is in the
  // body and in the preheader, both of which go through the tag.
  const subject = `${APP_NAME}: a worker node stopped responding`;

  const ctaUrl = data.appUrl ? `${data.appUrl}${WORKERS_ADMIN_PATH}` : undefined;

  const rows: SafeHtml[] = [
    detailRow('Node', data.nodeName),
    detailRow('Node id', data.nodeId),
    detailRow('Last heartbeat', heartbeat),
    detailRow('Marked offline at', markedAt),
    detailRow('Stale after', `${data.staleAfterMinutes} minute(s)`),
  ];

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      A worker node registered with ${APP_NAME} stopped sending heartbeats for
      longer than the configured stale window, and has been marked
      <strong>offline</strong>. Nothing observed it fail — it simply stopped
      answering.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
      ${rows}
    </table>
    <p style="margin:0 0 16px 0;">
      Jobs it was holding are released by the queue's own lease sweep and will
      be retried elsewhere. Until this node comes back, the fleet has less
      capacity than it was sized for.
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      You are receiving this because you can view worker nodes in ${APP_NAME}.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Worker node went offline',
    previewText: `${data.nodeName} last checked in at ${heartbeat}.`,
    bodyHtml,
    ctaLabel: ctaUrl ? 'Open worker nodes' : undefined,
    ctaUrl,
  });

  const text = plainText({
    title: 'Worker node went offline',
    lines: [
      `A worker node registered with ${APP_NAME} stopped sending heartbeats for longer`,
      'than the configured stale window, and has been marked OFFLINE. Nothing observed',
      'it fail - it simply stopped answering.',
      '',
      `  Node:               ${data.nodeName}`,
      `  Node id:            ${data.nodeId}`,
      `  Last heartbeat:     ${heartbeat}`,
      `  Marked offline at:  ${markedAt}`,
      `  Stale after:        ${data.staleAfterMinutes} minute(s)`,
      '',
      "Jobs it was holding are released by the queue's own lease sweep and will be",
      'retried elsewhere. Until this node comes back, the fleet has less capacity',
      'than it was sized for.',
      '',
      `You are receiving this because you can view worker nodes in ${APP_NAME}.`,
    ],
    ctaLabel: ctaUrl ? 'Open worker nodes' : undefined,
    ctaUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
