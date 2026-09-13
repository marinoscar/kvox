import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ApiDataResponse } from '../../common/decorators/api-data-response.decorator';
import { AVATAR_MAX_BYTES } from '../../common/profile-image/profile-image';
import { ProfileImageService } from './profile-image.service';
import { AvatarService } from './avatar.service';
import { ProfileImageResponseDto } from './dto/profile-image-response.dto';

const MAX_MB = AVATAR_MAX_BYTES / (1024 * 1024);

/**
 * Translate `@fastify/multipart` errors (plain FastifyErrors, which the global
 * filter would otherwise turn into a 500) into client errors.
 */
function toClientError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return new PayloadTooLargeException(
      `Profile image exceeds the ${MAX_MB} MB limit`,
    );
  }
  if (typeof code === 'string' && code.startsWith('FST_')) {
    return new BadRequestException(
      'Invalid multipart body. Send multipart/form-data with a single "file" field.',
    );
  }
  return error;
}

@ApiTags('User Settings')
@Controller('user-settings/profile-image')
export class ProfileImageController {
  constructor(
    private readonly profileImages: ProfileImageService,
    private readonly avatars: AvatarService,
  ) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get your uploaded profile picture (preview)',
    description:
      'Streams the caller\'s stored uploaded picture (`profile.imageObjectId`) whatever ' +
      '`profile.imageSource` is selected, so a settings UI can preview the upload option while ' +
      '`none` or `provider` is selected. Unlike the public `/api/users/{userId}/avatar/{objectId}` ' +
      'route it requires authentication and only ever serves the caller\'s own picture. ' +
      '404 when no picture is uploaded or its bytes are unavailable.',
  })
  @ApiProduces('image/jpeg', 'image/png', 'image/gif', 'image/webp')
  @ApiResponse({
    status: 200,
    description: 'Image bytes',
    content: {
      'image/*': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 404, description: 'Not found' })
  async preview(
    @CurrentUser('id') userId: string,
    @Res() reply: FastifyReply,
  ) {
    const avatar = await this.avatars.openStored(userId);

    reply
      .status(200)
      // The stored type was determined from magic bytes at upload time.
      .header('Content-Type', avatar.mimeType)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      // Per-user and changes on every upload/remove: never cached.
      .header('Cache-Control', 'private, no-store');

    if (avatar.size > BigInt(0)) {
      reply.header('Content-Length', avatar.size.toString());
    }

    return reply.send(avatar.stream);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Upload a profile picture',
    description:
      `Multipart upload with a single \`file\` field. The type is determined from the file's ` +
      `content (magic bytes) — the declared MIME type and filename are ignored — and must be ` +
      `JPEG, PNG, GIF or WebP; anything else (SVG included) is a 400. Maximum ${MAX_MB} MB ` +
      `(413 above it). On success the picture is selected (\`profile.imageSource: "upload"\`) and ` +
      `any previously uploaded picture is deleted.`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiDataResponse(ProfileImageResponseDto, {
    description: 'Picture stored and selected',
  })
  @ApiResponse({ status: 400, description: 'Missing file, invalid multipart body, or unsupported image type' })
  @ApiResponse({ status: 413, description: `File exceeds ${MAX_MB} MB` })
  async upload(
    @Req() req: FastifyRequest,
    @CurrentUser('id') userId: string,
  ) {
    if (!req.isMultipart()) {
      throw new BadRequestException(
        'Expected multipart/form-data with a single "file" field.',
      );
    }

    let buffer: Buffer;
    try {
      const part = await req.file({
        limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
        throwFileSizeLimit: true,
      });

      if (!part) {
        throw new BadRequestException('No file provided');
      }
      if (part.fieldname !== 'file') {
        throw new BadRequestException('The file must be sent in the "file" field.');
      }

      // Buffered, bounded by `fileSize`: 5 MB is small enough to hold, and the
      // magic bytes must be inspected before anything reaches storage.
      // `toBuffer` rejects with FST_REQ_FILE_TOO_LARGE on a truncated file.
      buffer = await part.toBuffer();
    } catch (error) {
      throw toClientError(error);
    }

    return this.profileImages.upload(userId, buffer);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.USER_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Remove the uploaded profile picture',
    description:
      'Deletes the uploaded picture (if any) and clears `profile.imageObjectId`. If the uploaded ' +
      'picture was selected, `profile.imageSource` falls back to `"provider"`. Idempotent.',
  })
  @ApiDataResponse(ProfileImageResponseDto, {
    description: 'Picture removed',
  })
  async remove(@CurrentUser('id') userId: string) {
    return this.profileImages.remove(userId);
  }
}
