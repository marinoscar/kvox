import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for device code generation
 * Follows RFC 8628 specification
 */
export class DeviceCodeResponseDto {
  @ApiProperty({
    description: 'Device verification code (opaque string for device)',
    example: 'a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4',
  })
  deviceCode!: string;

  @ApiProperty({
    description: 'User verification code (human-readable)',
    example: 'ABCD-1234',
  })
  userCode!: string;

  @ApiProperty({
    description:
      'End-user verification URI to display to the user. Built from this deployment\'s ' +
      '`APP_URL`; it resolves to the `/activate` page. Always use this value — do not ' +
      'hardcode the path.',
    example: 'http://localhost:3535/activate',
  })
  verificationUri!: string;

  @ApiProperty({
    description:
      'Same URI with the user code pre-filled as a `code` query parameter, for devices that ' +
      'can render a link or a QR code.',
    example: 'http://localhost:3535/activate?code=ABCD-1234',
  })
  verificationUriComplete!: string;

  @ApiProperty({
    description:
      'Lifetime in seconds of device_code and user_code (`DEVICE_CODE_EXPIRY_MINUTES`, ' +
      '15 minutes by default). This is the window in which the user must approve; it is ' +
      'unrelated to the lifetime of the credential eventually issued.',
    example: 900,
  })
  expiresIn!: number;

  @ApiProperty({
    description: 'Minimum polling interval in seconds',
    example: 5,
  })
  interval!: number;
}
