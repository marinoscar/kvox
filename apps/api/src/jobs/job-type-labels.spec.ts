import { ExampleEchoHandler } from './handlers/example-echo.handler';
import { JOB_TYPE_LABELS, jobTypeLabel } from './job-type-labels';

describe('jobTypeLabel', () => {
  it('returns the mapped label for a known type', () => {
    expect(jobTypeLabel('example.echo')).toBe('Example echo');
  });

  it('falls back to the raw type string for an unmapped type', () => {
    // The case a fork lives in: its own handlers are never in this map, and a
    // dashboard cell must not render blank for them.
    expect(jobTypeLabel('my-feature.do-the-thing')).toBe(
      'my-feature.do-the-thing',
    );
  });

  it('never returns an empty label for a non-empty type', () => {
    for (const type of ['a', 'example.echo', 'unknown.type', 'x.y.z']) {
      expect(jobTypeLabel(type).length).toBeGreaterThan(0);
    }
  });

  it('labels every type #353 converted, so the dashboard never shows a dotted key', () => {
    // ⚠ NOT A REQUIREMENT OF THE MECHANISM — an unmapped type renders as itself
    // — but these eight arrived together and an operator meeting them for the
    // first time is meeting them in a job list. The list is spelled out rather
    // than derived from a registry so that adding a ninth type is a deliberate
    // decision about its label rather than a silently-passing one.
    const converted = [
      'db.restore.run',
      'db.backup.sweep',
      'db.restore.old-db-drop',
      'storage.cleanup.stale-uploads',
      'auth.token.cleanup',
      'device-auth.code.cleanup',
      'nodes.fleet.sweep',
      'nodes.fleet.prune',
    ];

    for (const type of converted) {
      expect(JOB_TYPE_LABELS[type]).toBeDefined();
      expect(jobTypeLabel(type)).not.toBe(type);
    }
  });

  it('covers the example handler shipped in this repository', () => {
    // Not a requirement of the mechanism — an unmapped type renders fine —
    // but the one type this repo ships should not be the odd one out.
    const handler = new ExampleEchoHandler({ register: () => undefined } as never);

    expect(JOB_TYPE_LABELS[handler.type]).toBeDefined();
  });
});
