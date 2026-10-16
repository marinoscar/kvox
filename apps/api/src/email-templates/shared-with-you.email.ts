import { APP_NAME } from '@app/shared';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  html,
  plainText,
  renderLayout,
  type EmailRenderContext,
  type SafeHtml,
  type RenderedEmail,
} from '@marinoscar/platform-api/email';
import { renderSharedWithYouEmail, type SharedWithYouNotificationData } from '@marinoscar/platform-api/sharing';

// =============================================================================
// `sharing.shared_with_you` (issue #485, epic #478)
// =============================================================================
//
// The platform sharing slice's "somebody shared a record with you" message. It
// replaces `transcripts.transcript_shared` (issue #29), whose `transcript-shared`
// template is retired. The WORDING is the slice's (`renderSharedWithYouEmail`);
// this file only gives it the app's layout, escaping and plain-text helpers, which
// is why it takes the same kit the group invitation does.
//
// What the message carries is decided by the resource type's `describe()`
// (`app-registrations/sharing.ts`): the transcript's TITLE, escaped by the `html`
// tag, and its path. The title is user-typed and is never in the subject line.
// =============================================================================

// Typed registration (issue #460): the platform's data shape, under this app's key.
declare module '@marinoscar/platform-api/email' {
  interface EmailTemplateDataMap {
    'shared-with-you': SharedWithYouNotificationData;
  }
}

/** Renders `sharing.shared_with_you` with this app's layout. */
export function sharedWithYouEmail(data: SharedWithYouNotificationData, ctx?: EmailRenderContext): RenderedEmail {
  const rendered = renderSharedWithYouEmail(data, {
    appName: APP_NAME,
    html,
    empty: html``,
    renderLayout: (options) => renderLayout({ ...options, bodyHtml: options.bodyHtml as SafeHtml }, ctx),
    plainText: (options) => plainText(options, ctx),
    headers: TRANSACTIONAL_EMAIL_HEADERS,
  });

  return {
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: { ...rendered.headers },
  };
}
