// Shared fixtures for the kg.extract unit specs (#363). Plain data only.

import { computeEffectiveSchema, type DomainKey, type UserAttributeDef } from '@app/shared/ontology';

import {
  buildExtractionContext,
  type ExtractionContext,
  type ExtractionInput,
  type KnownEntityRow,
} from '../../src/graph/extraction/extraction-context';

export const IDS = {
  owner: '0a000000-0000-4000-8000-000000000001',
  note: '0b000000-0000-4000-8000-000000000001',
  transcript: '0c000000-0000-4000-8000-000000000001',
  seg1: '0d000000-0000-4000-8000-000000000001',
  seg2: '0d000000-0000-4000-8000-000000000002',
  seg3: '0d000000-0000-4000-8000-000000000003',
  spkA: '0e000000-0000-4000-8000-00000000000a',
  spkB: '0e000000-0000-4000-8000-00000000000b',
  sarah: '0f000000-0000-4000-8000-000000000001',
  northwind: '0f000000-0000-4000-8000-000000000002',
  pilot: '0f000000-0000-4000-8000-000000000003',
  meeting: '0f000000-0000-4000-8000-000000000009',
};

export function schemaFor(domains: DomainKey[] = ['core', 'work'], userAttributes: UserAttributeDef[] = []) {
  return computeEffectiveSchema({ enabledDomains: domains, userAttributes });
}

export function known(id: string, type: string, label: string, extra: Partial<KnownEntityRow> = {}): KnownEntityRow {
  return { id, type, label, aliases: [], reviewStatus: 'accepted', mergedIntoId: null, ...extra };
}

export const SEGMENT_TEXT = {
  s1: "Hi everyone, I'm Sarah Chen, VP of Operations at Northwind Robotics.",
  s2: "Thanks Sarah. We decided to go with Postgres for the pilot.",
  s3: "I'll send the updated proposal by Friday.",
};

export const NOTE_BODY =
  '# Pilot kickoff\n\nSarah Chen (Northwind Robotics) sponsors the pick-path pilot.\n\n' +
  '- Decision: use Postgres.\n- Sarah will send the updated proposal by Friday.';

export function makeInput(overrides: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    note: {
      id: IDS.note,
      title: 'Pilot kickoff',
      bodyAtVersion: NOTE_BODY,
      version: 2,
      contextText: 'Kickoff with Northwind about the pilot.',
      createdAt: new Date('2026-03-04T09:00:00.000Z'),
    },
    transcript: {
      id: IDS.transcript,
      title: 'Pilot kickoff call',
      recordedAt: new Date('2026-03-02T15:00:00.000Z'),
      createdAt: new Date('2026-03-02T15:00:00.000Z'),
    },
    segments: [
      { id: IDS.seg1, rev: 3, startMs: 0, endMs: 5000, speakerId: IDS.spkA, text: SEGMENT_TEXT.s1 },
      { id: IDS.seg2, rev: 1, startMs: 5000, endMs: 9000, speakerId: IDS.spkB, text: SEGMENT_TEXT.s2 },
      { id: IDS.seg3, rev: 1, startMs: 723_000, endMs: 726_000, speakerId: IDS.spkA, text: SEGMENT_TEXT.s3 },
    ],
    speakers: [
      { id: IDS.spkA, label: 'A', displayName: 'Sarah Chen', personEntityId: IDS.sarah },
      { id: IDS.spkB, label: 'B', displayName: null, personEntityId: null },
    ],
    effectiveSchema: schemaFor(),
    guidance: null,
    knownEntityCandidates: {
      pinned: [],
      speakerPersons: [known(IDS.sarah, 'Person', 'Sarah Chen', { aliases: ['Sarah', 'S. Chen'], orgLabel: 'Northwind Robotics' })],
      organizations: [known(IDS.northwind, 'Organization', 'Northwind Robotics', { aliases: ['NWR'] })],
      contextPool: [known(IDS.pilot, 'Project', 'Pick-path pilot', { aliases: ['pilot'] })],
      recentlyMentioned: [],
    },
    existingMeeting: null,
    ...overrides,
  };
}

export function makeContext(overrides: Partial<ExtractionInput> = {}): ExtractionContext {
  return buildExtractionContext(makeInput(overrides));
}

type Row = Record<string, unknown>;
export interface RawAnswer {
  meeting: { topics: string[] };
  entities: Row[];
  relations: Row[];
  items: Row[];
}

/** A well-formed model answer against `makeContext()`. */
export function goodAnswer(): RawAnswer {
  return {
    meeting: { topics: ['warehouse throughput'] },
    entities: [
      {
        ref: 'k1',
        type: 'Person',
        label: 'Sarah Chen',
        aliases: ['Sarah'],
        props: { title: 'VP of Operations' },
        evidence: [{ source: 's1', quote: "I'm Sarah Chen, VP of Operations" }],
      },
      {
        ref: 'e1',
        type: 'Project',
        label: 'Postgres migration',
        aliases: [],
        props: { status: null, startDate: null, endDate: null },
        evidence: [{ source: 'N', quote: 'Decision: use Postgres.' }],
      },
    ],
    relations: [
      {
        type: 'WORKS_FOR',
        from: 'k1',
        to: 'k2',
        props: {},
        validFrom: null,
        validTo: null,
        precision: 'unknown',
        evidence: [{ source: 's1', quote: 'Northwind Robotics' }],
      },
    ],
    items: [
      {
        kind: 'commitment',
        title: 'Send updated proposal',
        statement: 'Sarah will send the updated proposal by Friday.',
        subject: 'e1',
        owner: 'k1',
        counterparty: null,
        status: 'open',
        occurredAt: null,
        dueAt: '2026-03-06',
        validFrom: null,
        validTo: null,
        precision: 'day',
        sensitivity: null,
        props: {},
        evidence: [{ source: 's3', quote: "I'll send the updated proposal by Friday." }],
      },
      {
        kind: 'decision',
        title: 'Use Postgres',
        statement: 'The team decided to use Postgres for the pilot.',
        subject: 'e1',
        owner: null,
        counterparty: null,
        status: null,
        occurredAt: '2026-03-02',
        dueAt: null,
        validFrom: null,
        validTo: null,
        precision: 'day',
        sensitivity: null,
        props: { rejectedOption: null },
        evidence: [{ source: 's2', quote: 'we decided to go with postgres' }],
      },
    ],
  };
}
