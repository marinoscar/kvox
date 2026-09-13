import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';

import { AvatarController } from './avatar.controller';
import { AvatarService } from './avatar.service';

function createMockReply(): jest.Mocked<FastifyReply> {
  const reply: Partial<jest.Mocked<FastifyReply>> = {
    status: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  return reply as jest.Mocked<FastifyReply>;
}

describe('AvatarController (#367)', () => {
  let controller: AvatarController;
  let mockAvatars: { open: jest.Mock };

  const userId = '11111111-1111-4111-8111-111111111111';
  const objectId = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    mockAvatars = { open: jest.fn() };
    controller = new AvatarController(mockAvatars as unknown as AvatarService);
  });

  it('streams the image with all the required response headers', async () => {
    const stream = Readable.from(['bytes']);
    mockAvatars.open.mockResolvedValue({
      stream,
      mimeType: 'image/png',
      size: BigInt(1234),
    });
    const reply = createMockReply();

    await controller.getAvatar(userId, objectId, reply);

    expect(mockAvatars.open).toHaveBeenCalledWith(userId, objectId);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(reply.header).toHaveBeenCalledWith(
      'X-Content-Type-Options',
      'nosniff',
    );
    expect(reply.header).toHaveBeenCalledWith(
      'Content-Disposition',
      'inline',
    );
    expect(reply.header).toHaveBeenCalledWith(
      'Content-Security-Policy',
      "default-src 'none'; sandbox",
    );
    expect(reply.header).toHaveBeenCalledWith(
      'Cache-Control',
      'private, max-age=86400',
    );
    expect(reply.header).toHaveBeenCalledWith('Content-Length', '1234');
    expect(reply.send).toHaveBeenCalledWith(stream);
  });

  it('lets a NotFoundException from the service propagate (no header is written first)', async () => {
    const { NotFoundException } = await import('@nestjs/common');
    mockAvatars.open.mockRejectedValue(new NotFoundException('Not found'));
    const reply = createMockReply();

    await expect(
      controller.getAvatar(userId, objectId, reply),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});
