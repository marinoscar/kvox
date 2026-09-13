import { Controller, Get, Param, Res } from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FastifyReply } from 'fastify';

import { Public } from '../../auth/decorators/public.decorator';
import { AvatarService } from './avatar.service';

/**
 * Public, same-origin avatar route (#367).
 *
 * Its own controller, deliberately NOT a method on `UsersController`: that
 * controller's routes are admin-gated, and a public route beside them is one
 * decorator edit away from being accidentally locked (or the others unlocked).
 * `/users/:userId/avatar/:objectId` cannot collide with `/users/:id` — the
 * segment counts differ.
 *
 * No `@Auth()`, so no bearer security is published for it. The global
 * MaintenanceGuard still applies, exactly as it does to other public routes.
 */
@ApiTags('Users')
@Controller('users')
export class AvatarController {
  constructor(private readonly avatars: AvatarService) {}

  @Get(':userId/avatar/:objectId')
  @Public()
  @ApiOperation({
    summary: 'Get a user\'s uploaded profile picture (public)',
    description:
      'Serves the picture only while it is the user\'s selected profile picture ' +
      '(`profile.imageSource: "upload"` and `profile.imageObjectId` equal to `objectId`). ' +
      'Every other case is an identical 404. No authentication, so it works in `<img src>`.',
  })
  @ApiParam({ name: 'userId', type: String, format: 'uuid' })
  @ApiParam({ name: 'objectId', type: String, format: 'uuid' })
  @ApiProduces('image/jpeg', 'image/png', 'image/gif', 'image/webp')
  @ApiResponse({
    status: 200,
    description: 'Image bytes',
    content: {
      'image/*': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getAvatar(
    @Param('userId') userId: string,
    @Param('objectId') objectId: string,
    @Res() reply: FastifyReply,
  ) {
    const avatar = await this.avatars.open(userId, objectId);

    reply
      .status(200)
      // The stored type was determined from magic bytes at upload time.
      .header('Content-Type', avatar.mimeType)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=86400');

    if (avatar.size > BigInt(0)) {
      reply.header('Content-Length', avatar.size.toString());
    }

    return reply.send(avatar.stream);
  }
}
