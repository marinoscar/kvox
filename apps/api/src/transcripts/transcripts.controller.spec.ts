// =============================================================================
// TranscriptsController — the weak ETag on GET :id / :id/segments (issue #323)
// =============================================================================
//
// Unit-level: the controller instance's methods are called directly (no HTTP,
// no guards executed — `@Auth()`'s guards only run inside Nest's real request
// pipeline), the same pattern `notifications.controller.spec.ts` documents.
// Every collaborator is a bare stand-in; what is under test is purely the
// controller's own branching — which validator it stamps, and whether it
// answers 304 or the full body for a given `If-None-Match`.
//
// `transcriptETag`/`versionETag`/`matchesETag` are pure and exported, so most
// of this is tested directly against them; the two `it`s at the bottom pin
// that `detail`/`segments` actually pass the RIGHT etag through — the part a
// pure-function test alone cannot see.
// =============================================================================

import { HttpStatus } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { identitiesFingerprint } from './editing/speaker-identity';
import type { TranscriptEditingService } from './transcript-editing.service';
import type { TranscriptSharingService } from './transcript-sharing.service';
import {
  TranscriptsController,
  matchesETag,
  transcriptETag,
  versionETag,
} from './transcripts.controller';
import type { TranscriptsService } from './transcripts.service';
import type { TranscriptExportService } from './export/transcript-export.service';

const USER: RequestUser = {
  id: 'user-1',
  email: 'someone@example.test',
  roles: ['Contributor'],
  permissions: ['transcripts:read'],
  isActive: true,
};

function fakeReply() {
  const headers: Record<string, string> = {};

  return {
    header: jest.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    status: jest.fn(),
    headers,
  } as unknown as FastifyReply & { headers: Record<string, string> };
}

function fakeRequest(ifNoneMatch?: string): FastifyRequest {
  return { headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {} } as unknown as FastifyRequest;
}

// ===========================================================================
// The pure validators
// ===========================================================================

describe('transcriptETag', () => {
  it('is exactly versionETag when there are no identities — every pre-#323 validator still matches', () => {
    expect(transcriptETag(3, {})).toBe('W/"v3"');
    expect(transcriptETag(3, {})).toBe(versionETag(3));
  });

  it('carries the fingerprint once at least one speaker has been named', () => {
    const etag = transcriptETag(3, { A: 'Oscar' });

    expect(etag).toBe(`W/"v3-${identitiesFingerprint({ A: 'Oscar' })}"`);
    expect(etag).not.toBe(versionETag(3));
  });

  it('changes when the identities change, at the same version', () => {
    expect(transcriptETag(3, { A: 'Oscar' })).not.toBe(transcriptETag(3, { A: 'Joe' }));
  });
});

// ===========================================================================
// GET :id / :id/segments
// ===========================================================================

describe('TranscriptsController — GET :id / :id/segments', () => {
  let controller: TranscriptsController;
  let transcripts: { detailConditional: jest.Mock; segmentsConditional: jest.Mock };

  beforeEach(() => {
    transcripts = {
      detailConditional: jest.fn(),
      segmentsConditional: jest.fn(),
    };

    controller = new TranscriptsController(
      transcripts as unknown as TranscriptsService,
      {} as TranscriptEditingService,
      {} as TranscriptSharingService,
      {} as TranscriptExportService,
    );
  });

  it('stamps W/"v3" and returns the body when nobody has named a speaker', async () => {
    transcripts.detailConditional.mockResolvedValue({
      payload: { id: 't1' },
      version: 3,
      identities: {},
    });

    const reply = fakeReply();
    const result = await controller.detail('t1', USER, fakeRequest(), reply);

    expect(reply.header).toHaveBeenCalledWith('ETag', 'W/"v3"');
    expect(result).toEqual({ id: 't1' });
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('stamps the fingerprinted ETag once a speaker has been identified', async () => {
    transcripts.detailConditional.mockResolvedValue({
      payload: { id: 't1' },
      version: 3,
      identities: { A: 'Oscar' },
    });

    const reply = fakeReply();
    await controller.detail('t1', USER, fakeRequest(), reply);

    expect(reply.header).toHaveBeenCalledWith('ETag', transcriptETag(3, { A: 'Oscar' }));
  });

  it('a poller holding the PRE-NAMING W/"v3" gets the full body, never a 304, once a speaker is named', async () => {
    transcripts.detailConditional.mockResolvedValue({
      payload: { id: 't1', speakers: [{ id: 'A', displayName: 'Oscar' }] },
      version: 3,
      identities: { A: 'Oscar' },
    });

    const reply = fakeReply();
    // The client is still holding the validator it got before the naming.
    const result = await controller.detail('t1', USER, fakeRequest('W/"v3"'), reply);

    expect(result).toEqual({ id: 't1', speakers: [{ id: 'A', displayName: 'Oscar' }] });
    expect(reply.status).not.toHaveBeenCalledWith(HttpStatus.NOT_MODIFIED);
  });

  it('a poller holding the CURRENT (fingerprinted) etag still gets a real 304', async () => {
    transcripts.detailConditional.mockResolvedValue({
      payload: { id: 't1' },
      version: 3,
      identities: { A: 'Oscar' },
    });

    const current = transcriptETag(3, { A: 'Oscar' });
    const reply = fakeReply();
    const result = await controller.detail('t1', USER, fakeRequest(current), reply);

    expect(result).toBeUndefined();
    expect(reply.status).toHaveBeenCalledWith(HttpStatus.NOT_MODIFIED);
  });

  it('GET :id/segments carries the same fingerprinted ETag as GET :id', async () => {
    transcripts.segmentsConditional.mockResolvedValue({
      payload: { currentVersion: 3, segments: [] },
      version: 3,
      identities: { A: 'Oscar' },
    });

    const reply = fakeReply();
    await controller.segments('t1', USER, fakeRequest(), reply);

    expect(reply.header).toHaveBeenCalledWith('ETag', transcriptETag(3, { A: 'Oscar' }));
  });
});

describe('matchesETag', () => {
  it('matches weakly — a client that stripped the W/ prefix still gets its 304', () => {
    expect(matchesETag('"v3"', 'W/"v3"')).toBe(true);
  });

  it('does not match a different fingerprint at the same version', () => {
    expect(matchesETag(transcriptETag(3, { A: 'Oscar' }), transcriptETag(3, { A: 'Joe' }))).toBe(
      false,
    );
  });
});
