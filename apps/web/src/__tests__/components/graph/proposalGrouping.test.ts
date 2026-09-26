import { describe, expect, it } from 'vitest';

import {
  blockingEndpoints,
  bulkTargetIds,
  describeSkipped,
  groupProposalItems,
  isChecked,
  requiresIndividualAccept,
} from '../../../components/graph/review/proposalGrouping';
import { draftItems, ITEM, proposalItem } from '../../mocks/graphData';

describe('groupProposalItems', () => {
  it('orders groups People → … → Relations → Closes and hides empty ones', () => {
    const groups = groupProposalItems(draftItems());
    expect(groups.map((group) => group.label)).toEqual([
      'People',
      'Organizations',
      'Projects',
      'Meeting',
      'Decisions',
      'Commitments',
      'Claims',
      'Person facts',
      'Other',
      'Relations',
      'Closes',
    ]);
    const withoutProjects = draftItems().filter((item) => item.groupKey !== 'Project');
    expect(groupProposalItems(withoutProjects).map((group) => group.key)).not.toContain('Project');
  });

  it('folds known and previously rejected rows into their disclosures', () => {
    const items = [
      ...draftItems(),
      proposalItem({ id: 'x-rejected', flags: ['previously_rejected'], decision: 'pending' }),
    ];
    const people = groupProposalItems(items).find((group) => group.key === 'Person');
    expect(people?.known.map((item) => item.id)).toEqual([ITEM.ana]);
    expect(people?.rejectedBefore.map((item) => item.id)).toEqual(['x-rejected']);
    expect(people?.rows.map((item) => item.id)).toEqual([ITEM.sarah, ITEM.tom]);
  });

  it('puts an unknown group key under Other', () => {
    const odd = proposalItem({ id: 'odd', groupKey: 'Somewhere' as never });
    expect(groupProposalItems([odd])[0].key).toBe('Other');
  });
});

describe('decisions', () => {
  it('checked ⇔ accept, edit or merge_into', () => {
    expect(isChecked('accept')).toBe(true);
    expect(isChecked('edit')).toBe(true);
    expect(isChecked('merge_into')).toBe(true);
    expect(isChecked('pending')).toBe(false);
    expect(isChecked('reject')).toBe(false);
  });

  it('sensitive person facts and closings need an individual accept', () => {
    const items = draftItems();
    const byId = (id: string) => items.find((item) => item.id === id)!;
    expect(requiresIndividualAccept(byId(ITEM.personFact))).toBe(true);
    expect(requiresIndividualAccept(byId(ITEM.closing))).toBe(true);
    expect(requiresIndividualAccept(byId(ITEM.claim))).toBe(false);
  });

  it('bulk targets every non-known row', () => {
    const people = groupProposalItems(draftItems()).find((group) => group.key === 'Person')!;
    expect(bulkTargetIds(people)).toEqual([ITEM.sarah, ITEM.tom]);
  });
});

describe('blockingEndpoints', () => {
  it('names a pending or rejected endpoint row', () => {
    const items = draftItems();
    const tomWorksFor = items.find((item) => item.id === ITEM.tomWorksFor)!;
    expect(blockingEndpoints(tomWorksFor, items)).toEqual([
      { field: 'from', ref: 'e2', label: 'Tom', itemId: ITEM.tom },
    ]);
    const worksFor = items.find((item) => item.id === ITEM.worksFor)!;
    expect(blockingEndpoints(worksFor, items)).toEqual([]);

    const rejected = items.map((item) =>
      item.id === ITEM.northwind ? { ...item, decision: 'reject' as const } : item,
    );
    expect(blockingEndpoints(worksFor, rejected).map((b) => b.label)).toEqual(['Northwind Robotics']);
  });

  it('ignores existing-entity endpoints and entity rows', () => {
    const items = draftItems();
    const linked = proposalItem({
      id: 'rel',
      kind: 'relation',
      payload: { ref: 'r9', type: 'WORKS_FOR', from: { entityId: 'x' }, to: { ref: 'e3' } },
    });
    expect(blockingEndpoints(linked, items)).toEqual([]);
    expect(blockingEndpoints(items[0], items)).toEqual([]);
  });
});

describe('describeSkipped', () => {
  it('says what the server would not bulk-accept', () => {
    expect(
      describeSkipped([
        { itemId: 'a', reason: 'sensitive_requires_individual_accept' },
        { itemId: 'b', reason: 'sensitive_requires_individual_accept' },
      ]),
    ).toBe('2 sensitive facts need to be accepted one by one');
    expect(describeSkipped([{ itemId: 'c', reason: 'closing_requires_individual_accept' }])).toBe(
      '1 closing needs to be accepted one by one',
    );
    expect(describeSkipped([{ itemId: 'd', reason: 'not_found' }])).toBe('1 row was no longer there');
    expect(describeSkipped([])).toBeNull();
  });
});
