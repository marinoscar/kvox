import { BROADCASTS_NOTIFICATIONS, NODES_NOTIFICATIONS, OPS_NOTIFICATIONS } from '@marinoscar/platform-api/notifications';
import { IDENTITY_NOTIFICATIONS } from '/home/user/kvox/apps/api/src/notifications-registry/identity.notifications';
import { ALLOWLIST_REMINDER_NOTIFICATIONS } from '/home/user/kvox/apps/api/src/notifications-registry/allowlist-reminder.notifications';
import { DB_BACKUP_NOTIFICATIONS } from '/home/user/kvox/apps/api/src/notifications-registry/db-backup.notifications';
import { TRANSCRIPTS_NOTIFICATIONS } from '/home/user/kvox/apps/api/src/notifications-registry/transcripts.notifications';
import { NOTES_NOTIFICATIONS } from '/home/user/kvox/apps/api/src/notifications-registry/notes.notifications';
import * as fs from 'fs';
const oldRaw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const all = [...IDENTITY_NOTIFICATIONS, ...ALLOWLIST_REMINDER_NOTIFICATIONS, ...BROADCASTS_NOTIFICATIONS, ...OPS_NOTIFICATIONS, ...NODES_NOTIFICATIONS, ...DB_BACKUP_NOTIFICATIONS, ...TRANSCRIPTS_NOTIFICATIONS, ...NOTES_NOTIFICATIONS];
const nw = all.map((n: any) => ({ event: n.event, emailTemplate: n.emailTemplate ?? null, hasBrowser: !!n.browserTemplate }));
const byKey = (a: any[]) => Object.fromEntries(a.map((x) => [x.event.key, x]));
const o = byKey(oldRaw), n = byKey(nw);
let bad = 0;
for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
  if (JSON.stringify(o[k]) !== JSON.stringify(n[k])) { bad++; console.log('DIFF', k, JSON.stringify(o[k]), JSON.stringify(n[k])); }
}
console.log('old order:', oldRaw.map((x: any) => x.event.key).join(','));
console.log('new order:', nw.map((x: any) => x.event.key).join(','));
console.log('events', nw.length, 'old', oldRaw.length, 'diffs', bad);
