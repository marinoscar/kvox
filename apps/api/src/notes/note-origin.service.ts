/**
 * Which transcript a note ultimately came from — issue #309.
 *
 * =============================================================================
 * WHAT THIS ANSWERS
 * =============================================================================
 *
 * A note generated from a transcript names it directly. A note generated from
 * ANOTHER note names only that note, and the recording behind it is one or more
 * hops further up the chain. The detail page wants to offer "play the source
 * recording" in both cases, so the API resolves the chain once, server-side,
 * rather than having a client walk `sourceNoteId` with a request per hop.
 *
 * =============================================================================
 * DETAIL ONLY — NEVER A LIST
 * =============================================================================
 *
 * The walk costs up to one read per hop plus one for the transcript. That is
 * fine for the single note a user is looking at and an N+1 on a page of twenty,
 * which is why `listShape` never calls this and the list/summary schemas omit
 * the field entirely.
 *
 * =============================================================================
 * ⚠ ALL OR NOTHING, SCOPED TO THE CALLER
 * =============================================================================
 *
 * Every intermediate note must be readable by the caller (owner-only today,
 * the same rule `NoteAccessService` applies), and the transcript must be
 * viewable by the caller right now (owned or shared, not being deleted — the
 * same reach `NoteSourceNameService` grants). Any break in the chain — a
 * document source, a missing or unreadable note, a cycle, a chain longer than
 * `MAX_NOTE_HOPS`, an unshared or deleting transcript — answers `null`. There
 * is deliberately no partial object: a title without an id, or an id without
 * the caller's right to follow it, would be a leak or a dead link.
 */

import { Injectable } from '@nestjs/common';
import type { Note, PlaybackStatus, TranscriptStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/** The furthest a note chain is followed before giving up. */
export const MAX_NOTE_HOPS = 5;

export interface NoteOriginTranscript {
  id: string;
  title: string;
  durationMs: number | null;
  status: TranscriptStatus;
  playbackStatus: PlaybackStatus;
  via: 'direct' | 'note_chain';
  hops: number;
}

/** What the resolver needs off the starting note. A full `Note` satisfies it. */
export type NoteOriginFields = Pick<
  Note,
  'id' | 'sourceType' | 'sourceTranscriptId' | 'sourceNoteId'
>;

@Injectable()
export class NoteOriginService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve `note`'s origin transcript as far as `userId` may follow it, or
   * `null`. The starting note itself is assumed readable — the caller has
   * already passed `NoteAccessService.require` to hold it.
   */
  async resolve(note: NoteOriginFields, userId: string): Promise<NoteOriginTranscript | null> {
    if (note.sourceType === 'transcript') {
      if (!note.sourceTranscriptId) return null;
      return this.transcript(note.sourceTranscriptId, userId, 'direct', 0);
    }

    if (note.sourceType !== 'note' || !note.sourceNoteId) return null;

    const visited = new Set<string>([note.id]);
    let nextId: string | null = note.sourceNoteId;

    for (let hops = 1; hops <= MAX_NOTE_HOPS; hops += 1) {
      if (!nextId || visited.has(nextId)) return null;
      visited.add(nextId);

      const row: {
        sourceType: Note['sourceType'];
        sourceTranscriptId: string | null;
        sourceNoteId: string | null;
        ownerId: string;
        status: Note['status'];
        deletedAt: Date | null;
      } | null = await this.prisma.note.findUnique({
        where: { id: nextId },
        select: {
          sourceType: true,
          sourceTranscriptId: true,
          sourceNoteId: true,
          ownerId: true,
          status: true,
          deletedAt: true,
        },
      });

      // Notes are owner-only: the same predicate `NoteAccessService` applies,
      // so an intermediate note the caller could not open breaks the chain.
      if (!row || row.ownerId !== userId || row.status === 'deleting' || row.deletedAt) {
        return null;
      }

      if (row.sourceType === 'transcript') {
        if (!row.sourceTranscriptId) return null;
        return this.transcript(row.sourceTranscriptId, userId, 'note_chain', hops);
      }

      if (row.sourceType !== 'note') return null;
      nextId = row.sourceNoteId;
    }

    return null;
  }

  /** The transcript, only when `userId` may view it right now. */
  private async transcript(
    id: string,
    userId: string,
    via: NoteOriginTranscript['via'],
    hops: number,
  ): Promise<NoteOriginTranscript | null> {
    const row = await this.prisma.transcript.findFirst({
      where: {
        id,
        deletedAt: null,
        status: { not: 'deleting' },
        // OWNED OR SHARED — the reach `TranscriptAccessService` grants for
        // `view`, expressed as a predicate exactly as `NoteSourceNameService`
        // does, so an unshared transcript falls out here.
        OR: [{ ownerId: userId }, { shares: { some: { userId } } }],
      },
      select: { id: true, title: true, durationMs: true, status: true, playbackStatus: true },
    });

    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      durationMs: row.durationMs,
      status: row.status,
      playbackStatus: row.playbackStatus,
      via,
      hops,
    };
  }
}
