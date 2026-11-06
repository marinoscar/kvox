// =============================================================================
// Reading one multipart file part, bounded (issue #51, shared by #810)
// =============================================================================
//
// Extracted from `NoteSourcesController` so the context-attachment upload reads its
// part exactly the same way: the ceiling bounds the READ (`throwFileSizeLimit`), a part that
// hits it is a 413 and never a truncated file stored as valid, and every other multipart
// failure is a 400. See `NoteSourcesController`'s header for the argument.
// =============================================================================

import { BadRequestException, InternalServerErrorException, PayloadTooLargeException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/** The 500 a request gets when the host never registered `@fastify/multipart` (a host duty, `$hostPlugins`). */
const HOST_MULTIPART_MISSING =
  'This host has not registered @fastify/multipart on its Fastify app, so uploads cannot be read ' +
  '(a kvox host duty: see docs/guides/kvox-desktop.md and $hostPlugins in packages/kvox-slice-peers.json).';

/**
 * Turn Fastify's multipart failures into the status they mean.
 *
 * `FST_REQ_FILE_TOO_LARGE` is a 413 and everything else in the `FST_` family is
 * a malformed body, which is a 400. Without this they surface as 500s, which
 * tells the user their file broke the server rather than that it is too big.
 */
/** The part of `@fastify/multipart`'s request decoration this controller uses. */
interface MultipartRequest {
  isMultipart(): boolean;
  file(options: { limits: { fileSize: number; files: number }; throwFileSizeLimit: boolean }): Promise<
    | {
        fieldname: string;
        filename: string;
        mimetype: string;
        toBuffer(): Promise<Buffer>;
        file?: { truncated?: boolean };
      }
    | undefined
  >;
}

function toClientError(error: unknown, maxBytes: number, noun: string): unknown {
  const code = (error as { code?: unknown } | null)?.code;

  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return new PayloadTooLargeException(
      `This ${noun} is larger than the ${maxBytes}-byte limit this deployment allows for ` +
        (noun === 'document' ? 'a note source document.' : 'a note context file.'),
    );
  }

  if (typeof code === 'string' && code.startsWith('FST_')) {
    return new BadRequestException(
      'Invalid multipart body. Send multipart/form-data with a single "file" field.',
    );
  }

  return error;
}


/**
 * Refuse a request this host cannot read a multipart body from: a 500 naming the plugin when it
 * was never registered, a 400 when the request is not multipart. Called BEFORE any setting is read.
 */
export function assertMultipart(request: FastifyRequest): void {
  const req = request as unknown as MultipartRequest;

  // A host that skipped the plugin has no decoration: say so instead of a bare TypeError.
  if (typeof req.isMultipart !== 'function') {
    throw new InternalServerErrorException(HOST_MULTIPART_MISSING);
  }

  if (!req.isMultipart()) {
    throw new BadRequestException('Expected multipart/form-data with a single "file" field.');
  }
}

/**
 * One uploaded file, read whole.
 *
 * @stability experimental
 */
export interface SingleFileUpload {
  filename: string;
  mimeType: string;
  body: Buffer;
}

/**
 * Read the request's single `file` part, never more than `maxBytes`.
 *
 * @param request - the Fastify request.
 * @param maxBytes - the ceiling, read BEFORE this call (it bounds the read).
 * @param noun - what the file is called in the 413 sentence.
 * @throws 400 for a missing or malformed part, 413 over the ceiling, 500 when the host never
 * registered `@fastify/multipart`.
 */
export async function readSingleFileUpload(
  request: FastifyRequest,
  maxBytes: number,
  noun: 'document' | 'file',
): Promise<SingleFileUpload> {
  assertMultipart(request);

  // `@fastify/multipart` decorates the request; its types are the host's, so the slice states
  // the two members it uses.
  const req = request as unknown as MultipartRequest;

  try {
    const part = await req.file({
      limits: { fileSize: maxBytes, files: 1 },
      throwFileSizeLimit: true,
    });

    if (!part) {
      throw new BadRequestException('No file provided');
    }

    if (part.fieldname !== 'file') {
      throw new BadRequestException(`The ${noun} must be sent in the "file" field.`);
    }

    const body = await part.toBuffer();

    // ⚠ `toBuffer` can return the first `fileSize` bytes WITHOUT throwing when the limit is
    // hit as the last chunk is read (#585); a truncated file is over the limit, never valid.
    if (part.file?.truncated) {
      throw Object.assign(new Error('File too large'), { code: 'FST_REQ_FILE_TOO_LARGE' });
    }

    return { filename: part.filename, mimeType: part.mimetype, body };
  } catch (error) {
    throw toClientError(error, maxBytes, noun);
  }
}
