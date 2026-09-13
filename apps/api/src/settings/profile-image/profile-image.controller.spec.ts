import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';

import { ProfileImageController } from './profile-image.controller';
import { ProfileImageService } from './profile-image.service';
import { AvatarService } from './avatar.service';

function createMockReply(): jest.Mocked<FastifyReply> {
  const reply: Partial<jest.Mocked<FastifyReply>> = {
    status: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  return reply as jest.Mocked<FastifyReply>;
}

/**
 * Unit coverage for `ProfileImageController#preview` (the authenticated
 * GET /api/user-settings/profile-image route, issue #367 follow-up),
 * mirroring the direct-controller-unit-test pattern already established by
 * `avatar.controller.spec.ts` for the public route's `getAvatar` handler.
 *
 * Kept deliberately narrow: which stored picture is served for which
 * `imageSource` is `AvatarService.openStored`'s job and is covered in
 * `avatar.service.spec.ts`; the integration spec covers the route end to
 * end over real HTTP. This file exists specifically to pin the header
 * contract — in particular that `Cache-Control` here is `private, no-store`
 * (never the public route's `max-age=86400`) and that `Content-Length` is
 * omitted when the stored object's size is zero.
 */
describe('ProfileImageController preview (#367)', () => {
  let controller: ProfileImageController;
  let mockAvatars: { openStored: jest.Mock };

  const userId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    mockAvatars = { openStored: jest.fn() };
    controller = new ProfileImageController(
      {} as unknown as ProfileImageService,
      mockAvatars as unknown as AvatarService,
    );
  });

  it('streams the image with all the required response headers', async () => {
    const stream = Readable.from(['bytes']);
    mockAvatars.openStored.mockResolvedValue({
      stream,
      mimeType: 'image/png',
      size: BigInt(1234),
    });
    const reply = createMockReply();

    await controller.preview(userId, reply);

    expect(mockAvatars.openStored).toHaveBeenCalledWith(userId);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(reply.header).toHaveBeenCalledWith(
      'X-Content-Type-Options',
      'nosniff',
    );
    expect(reply.header).toHaveBeenCalledWith('Content-Disposition', 'inline');
    expect(reply.header).toHaveBeenCalledWith(
      'Content-Security-Policy',
      "default-src 'none'; sandbox",
    );
    // Authenticated, per-user preview: never cached — distinct from the
    // public avatar route's `private, max-age=86400`.
    expect(reply.header).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(reply.header).toHaveBeenCalledWith('Content-Length', '1234');
    expect(reply.send).toHaveBeenCalledWith(stream);
  });

  it('omits the Content-Length header when the stored object size is 0', async () => {
    const stream = Readable.from(['']);
    mockAvatars.openStored.mockResolvedValue({
      stream,
      mimeType: 'image/png',
      size: BigInt(0),
    });
    const reply = createMockReply();

    await controller.preview(userId, reply);

    expect(reply.header).not.toHaveBeenCalledWith(
      'Content-Length',
      expect.anything(),
    );
    expect(reply.send).toHaveBeenCalledWith(stream);
  });

  it('lets a NotFoundException from the service propagate (no header is written first)', async () => {
    const { NotFoundException } = await import('@nestjs/common');
    mockAvatars.openStored.mockRejectedValue(new NotFoundException('Not found'));
    const reply = createMockReply();

    await expect(controller.preview(userId, reply)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});
