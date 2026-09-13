import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APP_NAME } from '@app/shared';

import { backupFailedEmail, type BackupFailedEmailData } from './backup-failed.email';
import { jobFailedEmail, type JobFailedEmailData } from './job-failed.email';
import { nodeOfflineEmail, type NodeOfflineEmailData } from './node-offline.email';
import {
  restoreCompletedEmail,
  type RestoreCompletedEmailData,
} from './restore-completed.email';

// =============================================================================
// The four operational templates — tests (issue #288, epic #254)
// =============================================================================
//
// `index.spec.ts` already loops every registered template through the shared
// contract (non-empty subject/html/text, escaping, no `<link>`/`<style>`/`src=`,
// table-based). What is asserted HERE is what is specific to these four, and
// each one is a claim `index.spec.ts` structurally cannot make:
//
//   1. THE OPERATOR'S FACTS ARE ACTUALLY IN THE MESSAGE. The reason these exist
//      is that a log line saying "backup failed" is not enough — the reader
//      needs the run, the reason, the type, the node, the cut-off. A template
//      that rendered a tasteful paragraph and dropped the payload would pass
//      every generic contract test.
//   2. THE TEXT PART IS HAND-WRITTEN. There is deliberately no HTML-to-text
//      helper, so the two parts have to be checked to carry the same facts.
//   3. NO PRODUCT NAME IS HARD-CODED (epic success criterion 11). `APP_NAME` is
//      the only seam; a literal would survive a fork's rename.
//   4. THE CTA IS OPTIONAL AND GOES THROUGH THE LAYOUT, so `safeUrl` applies.
// =============================================================================

const APP_URL = 'https://app.example.com';

const JOB_FAILED: JobFailedEmailData = {
  jobId: 'job-abc',
  jobType: 'admin.broadcast.chunk',
  error: 'the provider refused the request',
  attempts: 3,
  executor: 'node-7',
  failedAt: new Date('2026-01-01T00:00:00.000Z'),
  appUrl: APP_URL,
};

const NODE_OFFLINE: NodeOfflineEmailData = {
  nodeId: 'node-abc',
  nodeName: 'worker-eu-1',
  lastHeartbeatAt: new Date('2026-01-01T00:00:00.000Z'),
  markedOfflineAt: new Date('2026-01-01T00:06:00.000Z'),
  staleAfterMinutes: 6,
  appUrl: APP_URL,
};

const BACKUP_FAILED: BackupFailedEmailData = {
  runId: 'run-abc',
  outcome: 'failed',
  error: 'pg_dump exited with code 1',
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  failedAt: new Date('2026-01-01T00:10:00.000Z'),
  trigger: 'scheduled',
  appUrl: APP_URL,
};

const RESTORE_COMPLETED: RestoreCompletedEmailData = {
  runId: 'run-abc',
  backupTakenAt: new Date('2026-01-01T00:00:00.000Z'),
  completedAt: new Date('2026-01-02T03:04:05.000Z'),
  triggeredBy: 'ops@example.com',
  preRestoreBackupId: 'run-pre',
  appUrl: APP_URL,
};

// ---------------------------------------------------------------------------
// 1 & 2. The facts reach BOTH parts
// ---------------------------------------------------------------------------

describe('job-failed', () => {
  const rendered = jobFailedEmail(JOB_FAILED);

  it('names the job type in the subject, so the inbox list is already useful', () => {
    expect(rendered.subject).toContain('admin.broadcast.chunk');
  });

  it('carries the type, id, error, attempt count and executor into BOTH parts', () => {
    for (const part of [rendered.html, rendered.text]) {
      expect(part).toContain('admin.broadcast.chunk');
      expect(part).toContain('job-abc');
      expect(part).toContain('the provider refused the request');
      expect(part).toContain('3');
      expect(part).toContain('node-7');
      expect(part).toContain('2026-01-01T00:00:00.000Z');
    }
  });

  it('says the job is terminal, because a reader who expects a retry will wait for one', () => {
    expect(rendered.html).toMatch(/not.*retried automatically/i);
    expect(rendered.text).toMatch(/NOT be retried automatically/i);
  });

  it('gives a null error and a null executor words rather than a blank', () => {
    const bare = jobFailedEmail({ ...JOB_FAILED, error: null, executor: null });

    expect(bare.text).toContain('Not recorded');
    expect(bare.html).toContain('Not recorded');
  });
});

describe('node-offline', () => {
  const rendered = nodeOfflineEmail(NODE_OFFLINE);

  it('carries the node name, id, last heartbeat and stale window into BOTH parts', () => {
    for (const part of [rendered.html, rendered.text]) {
      expect(part).toContain('worker-eu-1');
      expect(part).toContain('node-abc');
      expect(part).toContain('2026-01-01T00:00:00.000Z');
      expect(part).toContain('6 minute(s)');
    }
  });

  it('keeps the operator-supplied node name OUT of the subject, which is not escaped', () => {
    // The subject is not built with the `html` tag and would carry an
    // attacker-chosen string verbatim. Every other surface goes through the
    // tag; this is the one that cannot, so the name is not put there.
    expect(rendered.subject).not.toContain('worker-eu-1');
  });

  it('spells out the never-heartbeated case rather than rendering a blank', () => {
    // A node that registered and never pinged is a genuinely different failure
    // — a bad credential, a firewall, a crash during startup — and a blank cell
    // reads as a formatting bug.
    const never = nodeOfflineEmail({ ...NODE_OFFLINE, lastHeartbeatAt: null });

    expect(never.html).toMatch(/never/i);
    expect(never.text).toMatch(/never/i);
  });

  it('does not assert a cause it cannot know', () => {
    // The sweep infers the failure from silence; nothing watched this node die.
    // (The phrase wraps across lines in the text part, so the assertion matches
    // the half that cannot move.)
    expect(rendered.text).toMatch(/Nothing observed/i);
    expect(rendered.html).toMatch(/Nothing observed it fail/i);
  });
});

describe('backup-failed', () => {
  const rendered = backupFailedEmail(BACKUP_FAILED);

  it('carries the run id, outcome, trigger, timestamps and reason into BOTH parts', () => {
    for (const part of [rendered.html, rendered.text]) {
      expect(part).toContain('run-abc');
      expect(part).toContain('failed');
      expect(part).toContain('scheduled');
      expect(part).toContain('2026-01-01T00:10:00.000Z');
      expect(part).toContain('pg_dump exited with code 1');
    }
  });

  it('leads with the consequence — one fewer recovery point, and no automatic retry', () => {
    expect(rendered.html).toMatch(/one fewer.*recovery point/is);
    expect(rendered.text).toMatch(/ONE FEWER RECOVERY POINT/);
    expect(rendered.text).toMatch(/NOT retried automatically/);
  });

  it("distinguishes 'stale' from 'failed' in words, not just in a field", () => {
    // An operator chases the two in completely different places: a dump's
    // stderr versus a host that disappeared.
    const stale = backupFailedEmail({ ...BACKUP_FAILED, outcome: 'stale' });

    expect(stale.text).toMatch(/stopped sending heartbeats/i);
    expect(stale.text).toMatch(/nothing observed it fail/i);
    expect(rendered.text).not.toMatch(/stopped sending heartbeats/i);
  });

  it('renders both outcomes with the same subject, because the audience and urgency are the same', () => {
    expect(backupFailedEmail({ ...BACKUP_FAILED, outcome: 'stale' }).subject).toBe(
      rendered.subject,
    );
  });
});

describe('restore-completed', () => {
  const rendered = restoreCompletedEmail(RESTORE_COMPLETED);

  it('leads with the CUT-OFF, which is the fact that decides whether to act now', () => {
    for (const part of [rendered.html, rendered.text]) {
      // The archive's own timestamp, not the restore's.
      expect(part).toContain('2026-01-01T00:00:00.000Z');
      expect(part).toMatch(/not present/i);
    }
  });

  it('carries the source run, the completion time and the actor into BOTH parts', () => {
    for (const part of [rendered.html, rendered.text]) {
      expect(part).toContain('run-abc');
      expect(part).toContain('2026-01-02T03:04:05.000Z');
      expect(part).toContain('ops@example.com');
    }
  });

  it('names the safety backup when one was taken, and the retained database when one was not', () => {
    expect(rendered.text).toContain('run-pre');

    const retained = restoreCompletedEmail({
      ...RESTORE_COMPLETED,
      preRestoreBackupId: null,
    });

    expect(retained.text).toMatch(/retained/i);
    expect(retained.text).not.toContain('run-pre');
  });

  it('explains the restart, so a restart in the monitoring is not opened as a second incident', () => {
    expect(rendered.text).toMatch(/exited immediately afterwards/i);
  });

  it('says it cannot be turned off, because a mailbox has no other place to say so', () => {
    // The same argument `role-changed.email.ts` makes: the event is
    // `mandatory: true`, and a reader who cannot find the toggle deserves to
    // know there is not one.
    expect(rendered.html).toMatch(/cannot be turned off/i);
    expect(rendered.text).toMatch(/cannot be turned off/i);
  });

  it('gives an unrecorded actor and an unrecorded cut-off words rather than blanks', () => {
    const bare = restoreCompletedEmail({
      ...RESTORE_COMPLETED,
      triggeredBy: null,
      backupTakenAt: null,
    });

    expect(bare.text).toContain('Not recorded');
    expect(bare.html).toContain('Not recorded');
  });
});

// ---------------------------------------------------------------------------
// 4. The CTA
// ---------------------------------------------------------------------------

describe('the CTA goes through the layout and is optional', () => {
  const cases: Array<[string, string, () => string, () => string]> = [
    [
      'job-failed',
      '/admin/settings/jobs',
      () => jobFailedEmail(JOB_FAILED).html,
      () => jobFailedEmail({ ...JOB_FAILED, appUrl: undefined }).html,
    ],
    [
      'node-offline',
      '/admin/settings/workers',
      () => nodeOfflineEmail(NODE_OFFLINE).html,
      () => nodeOfflineEmail({ ...NODE_OFFLINE, appUrl: undefined }).html,
    ],
    [
      'backup-failed',
      '/admin/settings/db-backup',
      () => backupFailedEmail(BACKUP_FAILED).html,
      () => backupFailedEmail({ ...BACKUP_FAILED, appUrl: undefined }).html,
    ],
    [
      'restore-completed',
      '/admin/settings/db-backup',
      () => restoreCompletedEmail(RESTORE_COMPLETED).html,
      () => restoreCompletedEmail({ ...RESTORE_COMPLETED, appUrl: undefined }).html,
    ],
  ];

  it.each(cases)(
    '%s links to %s when an app URL is configured',
    (_name, path, withUrl) => {
      // The path is the one the card in `apps/web/src/config/adminSections.tsx`
      // declares. A CTA that lands somewhere else is worse than none.
      expect(withUrl()).toContain(`${APP_URL}${path}`);
    },
  );

  it.each(cases)(
    '%s omits the button entirely when no app URL is configured',
    (_name, path, _withUrl, withoutUrl) => {
      const html = withoutUrl();

      expect(html).not.toContain(path);
      // And no bare `href` left dangling by a half-rendered button.
      expect(html).not.toMatch(/href="undefined/);
    },
  );

  it('renders no CTA at all for a javascript: app URL, because the layout applies safeUrl', () => {
    const html = jobFailedEmail({
      ...JOB_FAILED,
      appUrl: 'javascript:alert(1)',
    }).html;

    expect(html).not.toContain('javascript:');
  });
});

// ---------------------------------------------------------------------------
// 3. THE BRANDING GUARD
// ---------------------------------------------------------------------------

describe('no product, application or repository name is hard-coded (epic #254, criterion 11)', () => {
  const FILES = [
    'job-failed.email.ts',
    'node-offline.email.ts',
    'backup-failed.email.ts',
    'restore-completed.email.ts',
  ];

  /**
   * Names a fork must be able to rename away, and which nothing in a template
   * may state literally. `APP_NAME` (from `@app/shared`) is the only seam.
   */
  const FORBIDDEN = [
    /EnterpriseAppBase/i,
    /Enterprise App (Base|Foundation)/i,
    // A default `APP_NAME` value hard-coded into a template would pass every
    // rendering test on this deployment and be wrong on every other one.
    new RegExp(APP_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  ];

  it.each(FILES)('%s contains no literal product name', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8');

    for (const pattern of FORBIDDEN) {
      expect(source).not.toMatch(pattern);
    }
  });

  it.each(FILES)('%s imports APP_NAME rather than restating it', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8');

    expect(source).toContain('APP_NAME');
    expect(source).toMatch(/from '\.\/layout'/);
  });

  it('every rendered part reads as this deployment’s name, which is APP_NAME', () => {
    const rendered = [
      jobFailedEmail(JOB_FAILED),
      nodeOfflineEmail(NODE_OFFLINE),
      backupFailedEmail(BACKUP_FAILED),
      restoreCompletedEmail(RESTORE_COMPLETED),
    ];

    for (const message of rendered) {
      expect(message.subject).toContain(APP_NAME);
      expect(message.html).toContain(APP_NAME);
      expect(message.text).toContain(APP_NAME);
    }
  });

  it('this guard covers every operational template on disk, so a fifth one cannot slip past it', () => {
    // The list above is hand-written; this makes forgetting to extend it a
    // failure rather than a silent gap.
    const onDisk = readdirSync(__dirname).filter(
      (name) =>
        name.endsWith('.email.ts') &&
        ['job-failed', 'node-offline', 'backup-failed', 'restore-completed'].some(
          (prefix) => name.startsWith(prefix),
        ),
    );

    expect(onDisk.sort()).toEqual([...FILES].sort());
  });
});

// ---------------------------------------------------------------------------
// 2. THE TEXT PART IS HAND-WRITTEN
// ---------------------------------------------------------------------------

describe('the text part is hand-written, not derived from the html', () => {
  const rendered = [
    jobFailedEmail(JOB_FAILED),
    nodeOfflineEmail(NODE_OFFLINE),
    backupFailedEmail(BACKUP_FAILED),
    restoreCompletedEmail(RESTORE_COMPLETED),
  ];

  it.each(rendered.map((message, index) => [index, message] as const))(
    'template %i: the text part carries no markup and no HTML entities',
    (_index, message) => {
      // There is deliberately no HTML-to-text helper in this codebase. A text
      // part containing tags or `&lt;` is the signature of one having been
      // introduced (or of somebody pasting the html through).
      expect(message.text).not.toMatch(/<[a-zA-Z!/][^>]*>/);
      expect(message.text).not.toContain('&lt;');
      expect(message.text).not.toContain('&amp;');
    },
  );

  it.each(rendered.map((message, index) => [index, message] as const))(
    'template %i: the text part is substantial rather than a stub',
    (_index, message) => {
      // A one-line "see the html version" text part is the failure this guards.
      expect(message.text.split(/\r?\n/).filter((line) => line.trim()).length,
      ).toBeGreaterThan(6);
    },
  );
});
