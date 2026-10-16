import { BadGatewayException, Logger, NotFoundException, NotImplementedException } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { StorageNotConfiguredError } from '@marinoscar/platform-api/storage';

import { KvoxS3PartLister, LIST_PARTS_UNSUPPORTED } from './kvox-s3-part-lister';

const KEY = 'uploads/org/1700000000000/abc.m4a';
const UPLOAD_ID = 'upload-1';

function s3Resolution(overrides: Partial<{ secret: string; bucket: string }> = {}) {
  return {
    configured: true as const,
    config: {
      provider: 's3',
      bucket: overrides.bucket ?? 'bucket-a',
      region: 'us-east-1',
      settings: { bucket: overrides.bucket ?? 'bucket-a', region: 'us-east-1', accessKeyId: 'AKIA', endpoint: '', forcePathStyle: null },
      secrets: { secretAccessKey: overrides.secret ?? 'secret-1' },
    },
  };
}

describe('KvoxS3PartLister', () => {
  let resolve: jest.Mock;
  let lister: KvoxS3PartLister;
  let send: jest.SpyInstance;
  let destroy: jest.SpyInstance;

  beforeEach(() => {
    resolve = jest.fn().mockResolvedValue(s3Resolution());
    lister = new KvoxS3PartLister({ resolve } as never);
    send = jest.spyOn(S3Client.prototype, 'send') as unknown as jest.SpyInstance;
    destroy = jest.spyOn(S3Client.prototype, 'destroy').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lists every page, ascending, with etag and size', async () => {
    send
      .mockResolvedValueOnce({
        Parts: [
          { PartNumber: 2, ETag: '"b"', Size: 20 },
          { PartNumber: 1, ETag: '"a"', Size: 10 },
        ],
        IsTruncated: true,
        NextPartNumberMarker: '2',
      })
      .mockResolvedValueOnce({ Parts: [{ PartNumber: 3, ETag: '"c"', Size: 5 }], IsTruncated: false });

    await expect(lister.listParts(KEY, UPLOAD_ID)).resolves.toEqual([
      { partNumber: 1, etag: '"a"', size: 10 },
      { partNumber: 2, etag: '"b"', size: 20 },
      { partNumber: 3, etag: '"c"', size: 5 },
    ]);

    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0][0].input;
    const second = send.mock.calls[1][0].input;
    expect(first).toMatchObject({ Bucket: 'bucket-a', Key: KEY, UploadId: UPLOAD_ID });
    expect(first.PartNumberMarker).toBeUndefined();
    expect(second.PartNumberMarker).toBe('2');
  });

  it('skips a part with no number and stops on a truncated page without a marker', async () => {
    send.mockResolvedValueOnce({ Parts: [{ ETag: '"x"', Size: 1 }, { PartNumber: 4, Size: 7 }], IsTruncated: true });

    await expect(lister.listParts(KEY, UPLOAD_ID)).resolves.toEqual([{ partNumber: 4, etag: '', size: 7 }]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('answers 501 list_parts_unsupported for a driver outside the S3 family', async () => {
    resolve.mockResolvedValue({
      configured: true,
      config: { provider: 'azure-blob', bucket: 'c', region: '', settings: {}, secrets: {} },
    });

    const error = await lister.listParts(KEY, UPLOAD_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotImplementedException);
    expect((error as NotImplementedException).getResponse()).toMatchObject({
      details: { reason: LIST_PARTS_UNSUPPORTED },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('answers 501 for a non-S3 driver that is not configured yet', async () => {
    resolve.mockResolvedValue({ configured: false, provider: 'local-disk', missing: ['path'] });
    await expect(lister.listParts(KEY, UPLOAD_ID)).rejects.toBeInstanceOf(NotImplementedException);
  });

  it('answers 503 (storage not configured) for an unconfigured S3-family driver', async () => {
    resolve.mockResolvedValue({ configured: false, provider: 's3', missing: ['bucket'] });
    await expect(lister.listParts(KEY, UPLOAD_ID)).rejects.toBeInstanceOf(StorageNotConfiguredError);
  });

  it('maps NoSuchUpload to 404', async () => {
    send.mockRejectedValue(Object.assign(new Error('The specified upload does not exist: secret-bucket'), { name: 'NoSuchUpload' }));
    await expect(lister.listParts(KEY, UPLOAD_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps any other provider failure to a 502 that carries no provider text and logs no key', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    send.mockRejectedValue(Object.assign(new Error(`AccessDenied for ${KEY} bucket-a secret-1`), { name: 'AccessDenied' }));

    const error = await lister.listParts(KEY, UPLOAD_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadGatewayException);
    const body = JSON.stringify((error as BadGatewayException).getResponse());
    expect(body).not.toContain('bucket-a');
    expect(body).not.toContain(KEY);
    expect(body).not.toContain('secret-1');
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain(KEY);
      expect(String(call[0])).not.toContain(UPLOAD_ID);
    }
  });

  it('reuses one client while the configuration is unchanged and rebuilds it when a secret rotates', async () => {
    send.mockResolvedValue({ Parts: [], IsTruncated: false });

    await lister.listParts(KEY, UPLOAD_ID);
    await lister.listParts(KEY, UPLOAD_ID);
    expect(destroy).not.toHaveBeenCalled();

    resolve.mockResolvedValue(s3Resolution({ secret: 'secret-2' }));
    await lister.listParts(KEY, UPLOAD_ID);
    expect(destroy).toHaveBeenCalledTimes(1);

    lister.onModuleDestroy();
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});
