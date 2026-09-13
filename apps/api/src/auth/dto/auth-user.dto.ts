import { ApiProperty } from '@nestjs/swagger';

/**
 * Role information
 */
export class RoleDto {
  @ApiProperty({
    example: 'admin',
    description: 'Role name',
  })
  name!: string;
}

/**
 * Current authenticated user information
 */
export class CurrentUserDto {
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'User ID',
  })
  id!: string;

  @ApiProperty({
    example: 'user@example.com',
    description: 'User email address',
  })
  email!: string;

  // `type` is explicit because `string | null` erases to `Object` in the
  // emitted design-time metadata, so without it the property publishes as an
  // object — a client generator would produce the wrong type for the field.
  @ApiProperty({
    type: String,
    example: 'John Doe',
    description: 'Display name (computed from override or provider)',
    nullable: true,
  })
  displayName!: string | null;

  @ApiProperty({
    type: String,
    example: '/api/users/123e4567-e89b-12d3-a456-426614174000/avatar/0b6f1c2e-7a53-4a8e-9d0c-2f6a1e9b7c11',
    description:
      'The picture representing the user, resolved from `profile.imageSource`: null for ' +
      '`none`, the provider picture for `provider`, or the same-origin avatar path for ' +
      '`upload`. May be an absolute URL or a root-relative path.',
    nullable: true,
  })
  profileImageUrl!: string | null;

  @ApiProperty({
    type: String,
    example: 'https://lh3.googleusercontent.com/a/example',
    description: 'The OAuth provider picture, regardless of the selected source',
    nullable: true,
  })
  providerProfileImageUrl!: string | null;

  @ApiProperty({
    type: Boolean,
    example: true,
    description:
      'Whether an uploaded picture is stored (`profile.imageObjectId` is set), regardless of the ' +
      'selected source. Preview it with the authenticated `GET /api/user-settings/profile-image`.',
  })
  hasUploadedProfileImage!: boolean;

  @ApiProperty({
    example: true,
    description: 'Whether the user account is active',
  })
  isActive!: boolean;

  @ApiProperty({
    type: [RoleDto],
    description: 'User roles',
  })
  roles!: RoleDto[];

  @ApiProperty({
    type: [String],
    example: ['system_settings:read', 'users:write'],
    description: 'User permissions (aggregated from roles)',
  })
  permissions!: string[];
}

/**
 * JWT token response
 */
export class TokenResponseDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT access token',
  })
  accessToken!: string;

  @ApiProperty({
    example: 900,
    description: 'Token expiration time in seconds',
  })
  expiresIn!: number;
}
