import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO representing a device session
 */
export class DeviceSessionDto {
  @ApiProperty({
    description: 'Device session ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'User verification code',
    example: 'ABCD-1234',
  })
  userCode!: string;

  @ApiProperty({
    description:
      'Device authorization status. This endpoint lists approved-but-unredeemed requests ' +
      'only, so in practice this is always `approved`.',
    enum: ['pending', 'approved', 'denied', 'expired'],
    example: 'approved',
  })
  status!: string;

  @ApiProperty({
    description: 'Client information',
    required: false,
  })
  clientInfo?: Record<string, any>;

  @ApiProperty({
    description:
      'When the device code was created, i.e. when the device started the flow. The approval ' +
      'instant is not recorded separately.',
    example: '2026-01-22T10:30:00Z',
  })
  createdAt!: string;

  @ApiProperty({
    description:
      'When the device CODE expires (`DEVICE_CODE_EXPIRY_MINUTES`, 15 minutes by default) — ' +
      'the deadline for the device to redeem it. Not the lifetime of the credential it ' +
      'receives, which is governed by `DEVICE_TOKEN_EXPIRY_DAYS` or `DEVICE_PAT_EXPIRY_DAYS`.',
    example: '2026-01-22T10:45:00Z',
  })
  expiresAt!: string;
}

/**
 * Paginated response DTO for device sessions
 */
export class DeviceSessionsResponseDto {
  @ApiProperty({
    description: 'Device authorizations on this page, newest first',
    type: [DeviceSessionDto],
  })
  sessions!: DeviceSessionDto[];

  @ApiProperty({
    description: 'Total number of matching device authorizations across all pages',
    example: 10,
  })
  total!: number;

  @ApiProperty({
    description: 'Current page number',
    example: 1,
  })
  page!: number;

  @ApiProperty({
    description: 'Page size',
    example: 10,
  })
  limit!: number;
}
