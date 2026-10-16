import * as P from '@marinoscar/platform-api/notifications';
import * as O from './notifications/channels/base-browser-templates';
const d = new Date('2026-01-02T03:04:05Z');
const samples: Record<string, any> = {
  broadcastBrowserTemplate: { title: 't', body: 'b', link: '/x' },
  roleChangedBrowserTemplate: { previousRoles: ['viewer'], currentRoles: [] },
  nodeOfflineBrowserTemplate: { nodeName: 'n1', lastHeartbeatAt: d },
  backupFailedBrowserTemplate: { runId: 'r1', outcome: 'stale', error: null },
  restoreCompletedBrowserTemplate: { runId: 'r2', backupTakenAt: d },
};
for (const [k, data] of Object.entries(samples)) {
  const a = JSON.stringify((O as any)[k](data)), b = JSON.stringify((P as any)[k](data));
  console.log(k, a === b ? 'SAME' : `DIFF\n ${a}\n ${b}`);
}
const d2 = { ...samples.nodeOfflineBrowserTemplate, lastHeartbeatAt: null };
console.log('nodeNull', JSON.stringify(O.nodeOfflineBrowserTemplate(d2 as never)) === JSON.stringify(P.nodeOfflineBrowserTemplate(d2 as never)));
const d3 = { runId: 'r', outcome: 'failed', error: 'boom' };
console.log('backupErr', JSON.stringify(O.backupFailedBrowserTemplate(d3 as never)) === JSON.stringify(P.backupFailedBrowserTemplate(d3 as never)));
