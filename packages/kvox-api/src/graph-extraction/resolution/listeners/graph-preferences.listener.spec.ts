import { GRAPH_PREFERENCE_DEFAULTS, type GraphPreferences } from '../../../graph/index.js';
import type { GraphPreferencesChangedEvent } from '../../../graph/index.js';
import { createInMemoryKvoxEvents } from '../../../testing/index.js';
import { GraphPreferencesListener } from './graph-preferences.listener.js';

const USER = '11111111-1111-4111-8111-111111111111';

function event(next: Partial<GraphPreferences['resolution']>, changed: GraphPreferencesChangedEvent['changed'] = ['resolution']): GraphPreferencesChangedEvent {
  return {
    userId: USER,
    changed,
    previous: GRAPH_PREFERENCE_DEFAULTS,
    next: { ...GRAPH_PREFERENCE_DEFAULTS, resolution: { ...GRAPH_PREFERENCE_DEFAULTS.resolution, ...next } },
  };
}

describe('GraphPreferencesListener', () => {
  const build = () => {
    const jobs = { enqueue: jest.fn(async () => ({ id: 'job' })) };
    const events = createInMemoryKvoxEvents();
    const listener = new GraphPreferencesListener(jobs as never, events);
    return { jobs, events, listener };
  };

  it.each([
    ['autoLinkThreshold', { autoLinkThreshold: 0.95 }],
    ['newThreshold', { newThreshold: 0.5 }],
  ])('enqueues one kg.resolve when %s changed', async (_name, next) => {
    const { jobs, listener } = build();
    await listener.handlePreferencesChanged(event(next));
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: 'kg.resolve',
      reason: 'rerun',
      subjectType: 'user',
      subjectId: USER,
      payload: { userId: USER, scope: 'all', reason: 'threshold_change' },
    });
  });

  it.each([
    ['the mode', event({ mode: 'review_all' })],
    ['the adjudication switch', event({ adjudication: 'off' })],
    ['another section', event({}, ['domains'])],
  ])('does nothing when only %s changed', async (_name, e) => {
    const { jobs, listener } = build();
    await listener.handlePreferencesChanged(e);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('subscribes to the preferences event on module init', async () => {
    const { jobs, events, listener } = build();
    listener.onModuleInit();
    events.emit('graph.preferences_changed', event({ autoLinkThreshold: 0.95 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it('only enqueues — a failing enqueue is logged, never thrown into the settings request', async () => {
    const { jobs, listener } = build();
    jobs.enqueue.mockRejectedValueOnce(new Error('db down'));
    await expect(listener.handlePreferencesChanged(event({ newThreshold: 0.6 }))).resolves.toBeUndefined();
  });
});
