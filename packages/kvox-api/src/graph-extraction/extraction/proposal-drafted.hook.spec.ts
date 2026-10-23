import { GRAPH_PROPOSAL_DRAFTED_EVENT } from '../../graph/index.js';
import { ProposalDraftedHook } from './proposal-drafted.hook.js';

const args = { proposalId: 'p1', ownerId: 'u1', noteId: 'n1', noteVersion: 3 };

describe('ProposalDraftedHook (#716, #718)', () => {
  function make(updateMany = jest.fn(async () => ({ count: 1 }))) {
    const events = { emit: jest.fn(), subscribe: jest.fn() };
    return { updateMany, events, hook: new ProposalDraftedHook({ noteLibraryFile: { updateMany } } as never, events as never) };
  }

  it('stamps extracted_version with one updateMany that never lowers it, then emits the draft event', async () => {
    const { hook, updateMany, events } = make();
    await hook.afterDraft(args);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { noteId: 'n1', OR: [{ extractedVersion: null }, { extractedVersion: { lt: 3 } }] },
      data: { extractedVersion: 3 },
    });
    expect(events.emit).toHaveBeenCalledWith(GRAPH_PROPOSAL_DRAFTED_EVENT, { ...args, kind: 'extraction' });
    expect(GRAPH_PROPOSAL_DRAFTED_EVENT).toBe('kvox.graph.proposal_drafted');
  });

  it('is best effort: a failed stamp is swallowed and the event still goes out', async () => {
    const { hook, events } = make(jest.fn(async () => Promise.reject(new Error('db down'))));
    await expect(hook.afterDraft(args)).resolves.toBeUndefined();
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});
