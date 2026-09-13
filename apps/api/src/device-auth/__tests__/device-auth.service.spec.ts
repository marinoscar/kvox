import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DeviceAuthService } from '../device-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../../auth/auth.service';
import { PatService } from '../../pat/pat.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import { DeviceCodeStatus } from '@prisma/client';

describe('DeviceAuthService', () => {
  let service: DeviceAuthService;
  let mockPrisma: MockPrismaService;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockPatService: { createToken: jest.Mock };

  const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
    isActive: true,
    userRoles: [
      {
        role: {
          name: 'viewer',
          rolePermissions: [
            { permission: { name: 'user_settings:read' } },
          ],
        },
      },
    ],
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockAuthService = {
      generateFullTokens: jest.fn().mockResolvedValue({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        expiresIn: 900,
      }),
    } as any;
    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'deviceAuth.expiryMinutes': 15,
          'deviceAuth.pollInterval': 5,
          // Belt-and-braces: the service's `?? defaultValue` fallback already
          // covers a missing key, but declaring it here keeps the mock
          // representative of the real config namespace (#141).
          'deviceAuth.patExpiryDays': 90,
          appUrl: 'http://localhost:3535',
        };
        return config[key] ?? defaultValue;
      }),
    } as any;
    mockPatService = {
      createToken: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceAuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PatService, useValue: mockPatService },
      ],
    }).compile();

    service = module.get<DeviceAuthService>(DeviceAuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateDeviceCode', () => {
    it('should generate valid device code and user code', async () => {
      mockPrisma.deviceCode.create.mockResolvedValue({
        id: 'device-code-1',
        deviceCode: 'hashed-device-code',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        clientInfo: {},
        scopes: [],
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        userId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const result = await service.generateDeviceCode();

      expect(result).toHaveProperty('deviceCode');
      expect(result).toHaveProperty('userCode');
      expect(result).toHaveProperty('verificationUri');
      expect(result).toHaveProperty('verificationUriComplete');
      expect(result).toHaveProperty('expiresIn');
      expect(result).toHaveProperty('interval');

      expect(result.deviceCode).toHaveLength(64); // 32 bytes hex = 64 chars
      expect(result.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(result.verificationUri).toBe('http://localhost:3535/activate');
      expect(result.verificationUriComplete).toContain(result.userCode);
      expect(result.expiresIn).toBe(900); // 15 minutes in seconds
      expect(result.interval).toBe(5);
    });

    it('should hash device code before storing', async () => {
      mockPrisma.deviceCode.create.mockResolvedValue({} as any);

      await service.generateDeviceCode();

      expect(mockPrisma.deviceCode.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          deviceCode: expect.any(String),
          userCode: expect.any(String),
          status: DeviceCodeStatus.pending,
        }),
      });

      // Verify the stored device code is hashed (64 chars hex)
      const call = mockPrisma.deviceCode.create.mock.calls[0][0];
      expect(call.data.deviceCode).toHaveLength(64);
    });

    it('should store client info when provided', async () => {
      const clientInfo = {
        deviceName: 'Smart TV',
        userAgent: 'Mozilla/5.0',
        ipAddress: '192.168.1.1',
      };

      mockPrisma.deviceCode.create.mockResolvedValue({} as any);

      await service.generateDeviceCode(clientInfo);

      expect(mockPrisma.deviceCode.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientInfo,
        }),
      });
    });

    it('should create device code with correct expiration', async () => {
      mockPrisma.deviceCode.create.mockResolvedValue({} as any);

      const beforeTime = new Date();
      beforeTime.setMinutes(beforeTime.getMinutes() + 15);

      await service.generateDeviceCode();

      const afterTime = new Date();
      afterTime.setMinutes(afterTime.getMinutes() + 15);

      const call = mockPrisma.deviceCode.create.mock.calls[0][0];
      const expiresAt = call.data.expiresAt;

      expect(new Date(expiresAt).getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(new Date(expiresAt).getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });
  });

  describe('pollForToken', () => {
    // Use unique device codes for each test to avoid rate limiting issues
    let testCounter = 0;
    const getUniqueDeviceCode = () => `device-code-${++testCounter}-${Date.now()}`;

    it('should throw authorization_pending when status is pending', async () => {
      const deviceCode = getUniqueDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        deviceCode: 'hashed',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        userId: null,
        user: null,
      } as any);

      try {
        await service.pollForToken(deviceCode);
        fail('Expected BadRequestException to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.response.error).toBe('authorization_pending');
      }
    });

    it('should throw access_denied when status is denied', async () => {
      const deviceCode = getUniqueDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        status: DeviceCodeStatus.denied,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);

      try {
        await service.pollForToken(deviceCode);
        fail('Expected BadRequestException to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.response.error).toBe('access_denied');
      }
    });

    it('should throw expired_token when code is expired', async () => {
      const deviceCode = getUniqueDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      try {
        await service.pollForToken(deviceCode);
        fail('Expected BadRequestException to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.response.error).toBe('expired_token');
      }

      // Should update status to expired
      expect(mockPrisma.deviceCode.update).toHaveBeenCalledWith({
        where: { id: 'device-code-1' },
        data: { status: DeviceCodeStatus.expired },
      });
    });

    it('should return tokens when status is approved', async () => {
      const deviceCode = getUniqueDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        status: DeviceCodeStatus.approved,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        userId: 'user-1',
        user: mockUser,
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      const result = await service.pollForToken(deviceCode);

      expect(result).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        tokenType: 'Bearer',
        expiresIn: 900,
      });

      expect(mockAuthService.generateFullTokens).toHaveBeenCalledWith(
        mockUser,
        expect.objectContaining({
          accessTtlMinutes: expect.any(Number),
          refreshTtlDays: expect.any(Number),
        }),
      );

      // Should mark as expired to prevent reuse
      expect(mockPrisma.deviceCode.update).toHaveBeenCalledWith({
        where: { id: 'device-code-1' },
        data: { status: DeviceCodeStatus.expired },
      });
    });

    it('should throw invalid_grant when device code not found', async () => {
      const deviceCode = getUniqueDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(null);

      try {
        await service.pollForToken(deviceCode);
        fail('Expected UnauthorizedException to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error.response.error).toBe('invalid_grant');
      }
    });

    it('should throw invalid_grant when user not found on approved code', async () => {
      const deviceCode = getUniqueDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        status: DeviceCodeStatus.approved,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        userId: 'user-1',
        user: null, // User was deleted
      } as any);

      try {
        await service.pollForToken(deviceCode);
        fail('Expected UnauthorizedException to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error.response.error).toBe('invalid_grant');
      }
    });

    it('should enforce rate limiting with slow_down error', async () => {
      // This test uses a fixed device code to test rate limiting
      const rateLimitDeviceCode = `rate-limit-test-${Date.now()}`;

      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);

      // First poll should throw authorization_pending
      try {
        await service.pollForToken(rateLimitDeviceCode);
      } catch (error: any) {
        expect(error.response.error).toBe('authorization_pending');
      }

      // Second immediate poll should throw slow_down
      try {
        await service.pollForToken(rateLimitDeviceCode);
        fail('Expected BadRequestException to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.response.error).toBe('slow_down');
      }
    });
  });

  // ---------------------------------------------------------------------
  // #141: device flow issues a revocable PAT for the CLI. Shared fixtures
  // for the PAT-branch tests below.
  // ---------------------------------------------------------------------
  let patCallCounter = 0;
  const uniquePatDeviceCode = () =>
    `pat-device-code-${++patCallCounter}-${Date.now()}`;

  function mockPatCreateResult(
    overrides: Partial<{
      token: string;
      id: string;
      name: string;
      expiresAt: string;
    }> = {},
  ) {
    return {
      token: overrides.token ?? 'pat_deadbeefcafebabe0123456789abcdef01234567',
      id: overrides.id ?? 'pat-id-1',
      name: overrides.name ?? 'Device: Test CLI',
      tokenPrefix: 'pat_dead',
      expiresAt:
        overrides.expiresAt ??
        new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
  }

  function mockApprovedRecord(id: string, clientInfo: any) {
    return {
      id,
      status: DeviceCodeStatus.approved,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      userId: 'user-1',
      user: mockUser,
      clientInfo,
    } as any;
  }

  describe('pollForToken — session path stays unchanged (#141)', () => {
    it('mints a session token when clientInfo.tokenType is absent', async () => {
      const deviceCode = uniquePatDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', undefined),
      );
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      const result = await service.pollForToken(deviceCode);

      expect(result).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        tokenType: 'Bearer',
        expiresIn: 900,
      });
      expect(mockPatService.createToken).not.toHaveBeenCalled();
    });

    it('mints a session token when clientInfo.tokenType is explicitly "session"', async () => {
      const deviceCode = uniquePatDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', { tokenType: 'session' }),
      );
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      const result = await service.pollForToken(deviceCode);

      expect(result).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        tokenType: 'Bearer',
        expiresIn: 900,
      });
      expect(mockPatService.createToken).not.toHaveBeenCalled();
    });

    it('returns exactly the four session keys — no more, no less', async () => {
      const deviceCode = uniquePatDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', undefined),
      );
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      const result = await service.pollForToken(deviceCode);

      expect(Object.keys(result).sort()).toEqual(
        ['accessToken', 'expiresIn', 'refreshToken', 'tokenType'].sort(),
      );
      expect(result).not.toHaveProperty('credentialType');
    });
  });

  describe('pollForToken — PAT path (#141)', () => {
    it('mints through PatService.createToken and returns accessToken as the raw token', async () => {
      const deviceCode = uniquePatDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', {
          tokenType: 'pat',
          deviceName: 'oscar-laptop',
        }),
      );
      mockPrisma.deviceCode.updateMany.mockResolvedValue({ count: 1 } as any);
      mockPatService.createToken.mockResolvedValue(
        mockPatCreateResult({ token: 'pat_rawtoken0123456789abcdef' }),
      );

      const result = await service.pollForToken(deviceCode);

      expect(mockPatService.createToken).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          name: 'Device: oscar-laptop',
          durationValue: 90,
          durationUnit: 'days',
        }),
      );
      expect(result.accessToken).toBe('pat_rawtoken0123456789abcdef');
    });

    it('keeps tokenType the literal "Bearer" — never "PAT"', async () => {
      const deviceCode = uniquePatDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', { tokenType: 'pat' }),
      );
      mockPrisma.deviceCode.updateMany.mockResolvedValue({ count: 1 } as any);
      mockPatService.createToken.mockResolvedValue(mockPatCreateResult());

      const result = await service.pollForToken(deviceCode);

      expect(result.tokenType).toBe('Bearer');
      expect(result.tokenType).not.toBe('PAT');
    });

    it('sets credentialType to "pat", present here and absent on the session response', async () => {
      const deviceCode = uniquePatDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', { tokenType: 'pat' }),
      );
      mockPrisma.deviceCode.updateMany.mockResolvedValue({ count: 1 } as any);
      mockPatService.createToken.mockResolvedValue(mockPatCreateResult());

      const result = await service.pollForToken(deviceCode);

      expect(result.credentialType).toBe('pat');
    });

    it('returns an absolute ISO expiresAt and the tokenId for revocation', async () => {
      const deviceCode = uniquePatDeviceCode();
      const isoExpiry = new Date(
        Date.now() + 90 * 24 * 60 * 60 * 1000,
      ).toISOString();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', { tokenType: 'pat' }),
      );
      mockPrisma.deviceCode.updateMany.mockResolvedValue({ count: 1 } as any);
      mockPatService.createToken.mockResolvedValue(
        mockPatCreateResult({ id: 'pat-xyz', expiresAt: isoExpiry }),
      );

      const result = await service.pollForToken(deviceCode);

      expect(result.expiresAt).toBe(isoExpiry);
      expect(() => new Date(result.expiresAt!).toISOString()).not.toThrow();
      expect(result.tokenId).toBe('pat-xyz');
    });
  });

  describe('pollForToken — raw token is never persisted (#141)', () => {
    it('does not call PatService.createToken on approval alone', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        clientInfo: { tokenType: 'pat', deviceName: 'My CLI' },
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      await service.authorizeDevice('user-1', 'ABCD-1234', true);

      expect(mockPatService.createToken).not.toHaveBeenCalled();
    });

    it('never writes the raw token string into any deviceCode.update/updateMany call', async () => {
      const deviceCode = uniquePatDeviceCode();
      const rawToken = 'pat_leakcheck_0123456789abcdef0123456789abcdef';
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', { tokenType: 'pat' }),
      );
      mockPrisma.deviceCode.updateMany.mockResolvedValue({ count: 1 } as any);
      mockPatService.createToken.mockResolvedValue(
        mockPatCreateResult({ token: rawToken }),
      );

      await service.pollForToken(deviceCode);

      const allCalls = [
        ...mockPrisma.deviceCode.update.mock.calls,
        ...mockPrisma.deviceCode.updateMany.mock.calls,
      ];
      expect(allCalls.length).toBeGreaterThan(0);
      for (const call of allCalls) {
        expect(JSON.stringify(call)).not.toContain(rawToken);
      }
    });
  });

  describe('pollForToken — atomic claim on the PAT path (#141)', () => {
    it('claims the code (status: approved -> expired) before minting the token', async () => {
      const deviceCode = uniquePatDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', { tokenType: 'pat' }),
      );
      mockPrisma.deviceCode.updateMany.mockResolvedValue({ count: 1 } as any);
      mockPatService.createToken.mockResolvedValue(mockPatCreateResult());

      await service.pollForToken(deviceCode);

      expect(mockPrisma.deviceCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'device-code-1', status: DeviceCodeStatus.approved },
        data: { status: DeviceCodeStatus.expired },
      });

      const claimOrder =
        mockPrisma.deviceCode.updateMany.mock.invocationCallOrder[0];
      const mintOrder = mockPatService.createToken.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(mintOrder);
    });

    it('throws and does not mint when the claim matches zero rows (concurrent poll)', async () => {
      const deviceCode = uniquePatDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', { tokenType: 'pat' }),
      );
      mockPrisma.deviceCode.updateMany.mockResolvedValue({ count: 0 } as any);

      await expect(service.pollForToken(deviceCode)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockPatService.createToken).not.toHaveBeenCalled();
    });

    it('does not leave the code claimable when createToken throws after the claim', async () => {
      const deviceCode = uniquePatDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', { tokenType: 'pat' }),
      );
      mockPrisma.deviceCode.updateMany.mockResolvedValue({ count: 1 } as any);
      mockPatService.createToken.mockRejectedValue(new Error('pat mint boom'));

      await expect(service.pollForToken(deviceCode)).rejects.toThrow(
        'pat mint boom',
      );

      // The claim happened exactly once and nothing put the code back into
      // an approved (re-claimable) state after the failure.
      expect(mockPrisma.deviceCode.updateMany).toHaveBeenCalledTimes(1);
      const allCalls = [
        ...mockPrisma.deviceCode.update.mock.calls,
        ...mockPrisma.deviceCode.updateMany.mock.calls,
      ];
      const revertedToApproved = allCalls.some(
        (call: any) => call[0]?.data?.status === DeviceCodeStatus.approved,
      );
      expect(revertedToApproved).toBe(false);
    });
  });

  describe('pollForToken — hostile deviceName sanitisation (#141)', () => {
    // Named by codepoint via \u escapes rather than typed as literal glyphs,
    // so the characters under test are unambiguous in source and in diffs.
    const ZERO_WIDTH_SPACE = '\u200B';
    const RIGHT_TO_LEFT_OVERRIDE = '\u202E';
    const LEFT_TO_RIGHT_MARK = '\u200E';
    const LEFT_TO_RIGHT_ISOLATE = '\u2066';
    const POP_DIRECTIONAL_ISOLATE = '\u2069';
    const ZERO_WIDTH_NO_BREAK_SPACE_BOM = '\uFEFF';
    const INVISIBLE_CHARS = [
      ZERO_WIDTH_SPACE,
      RIGHT_TO_LEFT_OVERRIDE,
      LEFT_TO_RIGHT_MARK,
      LEFT_TO_RIGHT_ISOLATE,
      POP_DIRECTIONAL_ISOLATE,
      ZERO_WIDTH_NO_BREAK_SPACE_BOM,
    ];

    async function pollAndCaptureName(deviceNameValue: unknown): Promise<string> {
      mockPrisma.deviceCode.findUnique.mockResolvedValueOnce(
        mockApprovedRecord('device-code-hostile', {
          tokenType: 'pat',
          deviceName: deviceNameValue,
        }),
      );
      mockPrisma.deviceCode.updateMany.mockResolvedValueOnce({
        count: 1,
      } as any);
      mockPatService.createToken.mockResolvedValueOnce(mockPatCreateResult());

      await service.pollForToken(uniquePatDeviceCode());

      const call = mockPatService.createToken.mock.calls.at(-1)!;
      return (call[1] as any).name;
    }

    it.each([
      ['number', 123],
      ['null', null],
      ['plain object', {}],
      ['array', []],
      ['boolean', true],
    ])('does not throw on a non-string deviceName (%s)', async (_label, value) => {
      await expect(pollAndCaptureName(value)).resolves.toBe(
        'Device: Unnamed device',
      );
    });

    it('falls back to the default name when empty or whitespace-only', async () => {
      expect(await pollAndCaptureName('')).toBe('Device: Unnamed device');
      expect(await pollAndCaptureName('   \t  ')).toBe(
        'Device: Unnamed device',
      );
    });

    it('strips control characters and newlines', async () => {
      const name = await pollAndCaptureName('My\nCLI\tDevice\r\n');
      expect(name).toBe('Device: My CLI Device');
      expect(name).not.toMatch(/[\r\n\t]/);
    });

    it('removes bidi overrides and zero-width characters', async () => {
      const hostile =
        `My${ZERO_WIDTH_SPACE}CLI${RIGHT_TO_LEFT_OVERRIDE}desktop` +
        `${LEFT_TO_RIGHT_MARK}${LEFT_TO_RIGHT_ISOLATE}tool` +
        `${POP_DIRECTIONAL_ISOLATE}${ZERO_WIDTH_NO_BREAK_SPACE_BOM}`;
      const name = await pollAndCaptureName(hostile);

      for (const invisible of INVISIBLE_CHARS) {
        expect(name.includes(invisible)).toBe(false);
      }
      expect(name.startsWith('Device: ')).toBe(true);
      expect(name).toBe('Device: MyCLIdesktoptool');
    });

    it('applies NFKC normalisation before stripping (fullwidth forms collapse)', async () => {
      const name = await pollAndCaptureName('ＣＬＩ'); // fullwidth "CLI"
      expect(name).toBe('Device: CLI');
    });

    it('truncates to <=100 chars and always keeps the "Device: " prefix', async () => {
      const hostile = 'A'.repeat(300);
      const name = await pollAndCaptureName(hostile);

      expect(name.length).toBeLessThanOrEqual(100);
      expect(name.startsWith('Device: ')).toBe(true);
    });

    it('keeps the prefix and length bound even for a combined hostile payload', async () => {
      const hostile =
        RIGHT_TO_LEFT_OVERRIDE +
        'evil\n'.repeat(50) +
        `${ZERO_WIDTH_SPACE}more\tcontrol\rchars`.repeat(3);
      const name = await pollAndCaptureName(hostile);

      expect(name.length).toBeLessThanOrEqual(100);
      expect(name.startsWith('Device: ')).toBe(true);
      expect(name).not.toMatch(/[\r\n\t]/);
      for (const invisible of INVISIBLE_CHARS) {
        expect(name.includes(invisible)).toBe(false);
      }
    });
  });

  describe('pollForToken — PAT expiry clamping (#141)', () => {
    it('falls back to 90 days when DEVICE_PAT_EXPIRY_DAYS is non-numeric', async () => {
      mockConfigService.get.mockImplementation(
        (key: string, defaultValue?: any) => {
          const config: Record<string, any> = {
            'deviceAuth.expiryMinutes': 15,
            'deviceAuth.pollInterval': 5,
            'deviceAuth.patExpiryDays': 'not-a-number',
            appUrl: 'http://localhost:3535',
          };
          return config[key] ?? defaultValue;
        },
      );
      const deviceCode = uniquePatDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', { tokenType: 'pat' }),
      );
      mockPrisma.deviceCode.updateMany.mockResolvedValue({ count: 1 } as any);
      mockPatService.createToken.mockResolvedValue(mockPatCreateResult());

      await service.pollForToken(deviceCode);

      expect(mockPatService.createToken).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ durationValue: 90, durationUnit: 'days' }),
      );
    });

    it('falls back to 90 days when DEVICE_PAT_EXPIRY_DAYS is out of range', async () => {
      mockConfigService.get.mockImplementation(
        (key: string, defaultValue?: any) => {
          const config: Record<string, any> = {
            'deviceAuth.expiryMinutes': 15,
            'deviceAuth.pollInterval': 5,
            'deviceAuth.patExpiryDays': 9000, // ~24.6 years — would exceed createPatSchema's ceiling
            appUrl: 'http://localhost:3535',
          };
          return config[key] ?? defaultValue;
        },
      );
      const deviceCode = uniquePatDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(
        mockApprovedRecord('device-code-1', { tokenType: 'pat' }),
      );
      mockPrisma.deviceCode.updateMany.mockResolvedValue({ count: 1 } as any);
      mockPatService.createToken.mockResolvedValue(mockPatCreateResult());

      await service.pollForToken(deviceCode);

      expect(mockPatService.createToken).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ durationValue: 90, durationUnit: 'days' }),
      );
    });
  });

  describe('getActivationInfo', () => {
    it('should return verification URI when no code provided', async () => {
      const result = await service.getActivationInfo();

      expect(result).toEqual({
        verificationUri: 'http://localhost:3535/activate',
      });
    });

    it('should return device info for valid user code', async () => {
      const clientInfo = {
        deviceName: 'Smart TV',
        userAgent: 'Mozilla/5.0',
      };

      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        clientInfo,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);

      const result = await service.getActivationInfo('abcd-1234');

      expect(result).toEqual({
        verificationUri: 'http://localhost:3535/activate',
        userCode: 'ABCD-1234',
        clientInfo,
        expiresAt: expect.any(String),
      });
    });

    it('should normalize user code (uppercase, no spaces)', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        clientInfo: {},
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);

      await service.getActivationInfo('abcd-1234');

      expect(mockPrisma.deviceCode.findUnique).toHaveBeenCalledWith({
        where: { userCode: 'ABCD-1234' },
      });
    });

    it('should throw NotFoundException for invalid user code', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue(null);

      await expect(
        service.getActivationInfo('INVALID-CODE'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getActivationInfo('INVALID-CODE'),
      ).rejects.toThrow('Invalid user code');
    });

    it('should throw BadRequestException for expired code', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() - 1000),
      } as any);

      await expect(service.getActivationInfo('ABCD-1234')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.getActivationInfo('ABCD-1234')).rejects.toThrow(
        'This code has expired',
      );
    });

    it('should throw BadRequestException for already processed code', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.approved,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);

      await expect(service.getActivationInfo('ABCD-1234')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.getActivationInfo('ABCD-1234')).rejects.toThrow(
        'This code has already been processed',
      );
    });
  });

  describe('authorizeDevice', () => {
    const userId = 'user-1';
    const userCode = 'ABCD-1234';

    it('should approve device successfully', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode,
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      const result = await service.authorizeDevice(userId, userCode, true);

      expect(result).toEqual({
        success: true,
        message: 'Device authorized successfully',
      });

      expect(mockPrisma.deviceCode.update).toHaveBeenCalledWith({
        where: { id: 'device-code-1' },
        data: {
          status: DeviceCodeStatus.approved,
          userId,
        },
      });
    });

    it('should deny device successfully', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode,
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      const result = await service.authorizeDevice(userId, userCode, false);

      expect(result).toEqual({
        success: true,
        message: 'Device authorization denied',
      });

      expect(mockPrisma.deviceCode.update).toHaveBeenCalledWith({
        where: { id: 'device-code-1' },
        data: {
          status: DeviceCodeStatus.denied,
          userId: null,
        },
      });
    });

    it('should normalize user code before lookup', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      await service.authorizeDevice(userId, 'abcd-1234', true);

      expect(mockPrisma.deviceCode.findUnique).toHaveBeenCalledWith({
        where: { userCode: 'ABCD-1234' },
      });
    });

    it('should throw NotFoundException for invalid user code', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue(null);

      await expect(
        service.authorizeDevice(userId, 'INVALID', true),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.authorizeDevice(userId, 'INVALID', true),
      ).rejects.toThrow('Invalid user code');
    });

    it('should throw BadRequestException for expired code', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode,
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() - 1000),
      } as any);

      await expect(
        service.authorizeDevice(userId, userCode, true),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.authorizeDevice(userId, userCode, true),
      ).rejects.toThrow('This code has expired');
    });

    it('should throw BadRequestException for already processed code', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode,
        status: DeviceCodeStatus.approved,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);

      await expect(
        service.authorizeDevice(userId, userCode, true),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.authorizeDevice(userId, userCode, true),
      ).rejects.toThrow('This code has already been processed');
    });
  });

  describe('getUserDeviceSessions', () => {
    it('should return paginated device sessions', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          userCode: 'ABCD-1234',
          status: DeviceCodeStatus.approved,
          clientInfo: { deviceName: 'Smart TV' },
          createdAt: new Date('2024-01-01'),
          expiresAt: new Date('2024-01-02'),
        },
        {
          id: 'session-2',
          userCode: 'EFGH-5678',
          status: DeviceCodeStatus.approved,
          clientInfo: { deviceName: 'Mobile App' },
          createdAt: new Date('2024-01-03'),
          expiresAt: new Date('2024-01-04'),
        },
      ];

      mockPrisma.deviceCode.findMany.mockResolvedValue(mockSessions as any);
      mockPrisma.deviceCode.count.mockResolvedValue(2);

      const result = await service.getUserDeviceSessions('user-1', 1, 10);

      expect(result).toEqual({
        sessions: [
          {
            id: 'session-1',
            userCode: 'ABCD-1234',
            status: DeviceCodeStatus.approved,
            clientInfo: { deviceName: 'Smart TV' },
            createdAt: expect.any(String),
            expiresAt: expect.any(String),
          },
          {
            id: 'session-2',
            userCode: 'EFGH-5678',
            status: DeviceCodeStatus.approved,
            clientInfo: { deviceName: 'Mobile App' },
            createdAt: expect.any(String),
            expiresAt: expect.any(String),
          },
        ],
        total: 2,
        page: 1,
        limit: 10,
      });

      expect(mockPrisma.deviceCode.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          status: DeviceCodeStatus.approved,
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip: 0,
        take: 10,
      });
    });

    it('should handle pagination correctly', async () => {
      mockPrisma.deviceCode.findMany.mockResolvedValue([]);
      mockPrisma.deviceCode.count.mockResolvedValue(25);

      await service.getUserDeviceSessions('user-1', 3, 10);

      expect(mockPrisma.deviceCode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20, // (page 3 - 1) * 10
          take: 10,
        }),
      );
    });

    it('should filter by approved status only', async () => {
      mockPrisma.deviceCode.findMany.mockResolvedValue([]);
      mockPrisma.deviceCode.count.mockResolvedValue(0);

      await service.getUserDeviceSessions('user-1');

      expect(mockPrisma.deviceCode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            status: DeviceCodeStatus.approved,
          },
        }),
      );
    });
  });

  describe('revokeDeviceSession', () => {
    it('should revoke device session successfully', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        status: DeviceCodeStatus.approved,
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      const result = await service.revokeDeviceSession('user-1', 'session-1');

      expect(result).toEqual({
        success: true,
        message: 'Device session revoked successfully',
      });

      expect(mockPrisma.deviceCode.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: DeviceCodeStatus.denied },
      });
    });

    it('should throw NotFoundException when session not found', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue(null);

      await expect(
        service.revokeDeviceSession('user-1', 'non-existent'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.revokeDeviceSession('user-1', 'non-existent'),
      ).rejects.toThrow('Session not found');
    });

    it('should throw NotFoundException when user does not own session', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'other-user',
        status: DeviceCodeStatus.approved,
      } as any);

      await expect(
        service.revokeDeviceSession('user-1', 'session-1'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.revokeDeviceSession('user-1', 'session-1'),
      ).rejects.toThrow('Session not found');

      // Should not attempt to update
      expect(mockPrisma.deviceCode.update).not.toHaveBeenCalled();
    });
  });

  describe('cleanupExpiredCodes', () => {
    it('should delete expired codes', async () => {
      mockPrisma.deviceCode.deleteMany.mockResolvedValue({ count: 5 } as any);

      const result = await service.cleanupExpiredCodes();

      expect(result).toBe(5);
      expect(mockPrisma.deviceCode.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { expiresAt: { lt: expect.any(Date) } },
            {
              status: DeviceCodeStatus.expired,
              updatedAt: {
                lt: expect.any(Date),
              },
            },
          ],
        },
      });
    });

    it('should return 0 when no codes to cleanup', async () => {
      mockPrisma.deviceCode.deleteMany.mockResolvedValue({ count: 0 } as any);

      const result = await service.cleanupExpiredCodes();

      expect(result).toBe(0);
    });
  });
});
