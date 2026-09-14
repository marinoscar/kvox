// =============================================================================
// `S3StorageProvider.listParts` — pagination (issue #21)
// =============================================================================
//
// ⚠ WHY A FAKE CLIENT AND NOT `aws-sdk-client-mock`: that package is not a
// dependency of this repository, and `listParts` needs exactly one thing from
// the SDK — that `send()` returns the shape `ListParts` returns. Assigning a
// `{ send }` object over the provider's own client is enough to drive every
// branch, and it adds no dependency to keep in step with the AWS SDK's major
// versions. If a later issue brings `aws-sdk-client-mock` in for another
// reason, this file is a fine thing to rewrite on top of it.
//
// WHAT IS ACTUALLY UNDER TEST is the loop, not the SDK: `ListParts` returns at
// most 1000 parts per response, and an unpaginated implementation reports a
// 10,000-part upload as permanently 1000/10000 done — so a resume re-uploads
// 9000 parts it already has.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { ListPartsCommand } from '@aws-sdk/client-s3';

import { S3StorageProvider } from './s3-storage.provider';

interface FakeClient {
  send: jest.Mock;
}

function createProvider(): { provider: S3StorageProvider; client: FakeClient } {
  const config = {
    get: jest.fn((key: string) => {
      const values: Record<string, unknown> = {
        'storage.s3.bucket': 'test-bucket',
        'storage.s3.region': 'us-east-1',
      };

      return values[key];
    }),
  } as unknown as ConfigService;

  const provider = new S3StorageProvider(config);
  const client: FakeClient = { send: jest.fn() };

  (provider as unknown as { s3Client: FakeClient }).s3Client = client;

  return { provider, client };
}

/** `count` parts starting at `from`, as `ListParts` would return them. */
function page(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    PartNumber: from + i,
    Size: 10485760,
    ETag: `"etag-${from + i}"`,
    LastModified: new Date('2026-01-01T00:00:00.000Z'),
  }));
}

describe('S3StorageProvider.listParts', () => {
  it('returns a single page unchanged', async () => {
    const { provider, client } = createProvider();

    client.send.mockResolvedValueOnce({ Parts: page(1, 3), IsTruncated: false });

    const parts = await provider.listParts('key', 'upload-1');

    expect(parts).toEqual([
      { partNumber: 1, size: 10485760, etag: '"etag-1"', lastModified: expect.any(Date) },
      { partNumber: 2, size: 10485760, etag: '"etag-2"', lastModified: expect.any(Date) },
      { partNumber: 3, size: 10485760, etag: '"etag-3"', lastModified: expect.any(Date) },
    ]);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('follows NextPartNumberMarker until IsTruncated is false', async () => {
    const { provider, client } = createProvider();

    client.send
      .mockResolvedValueOnce({
        Parts: page(1, 1000),
        IsTruncated: true,
        NextPartNumberMarker: '1000',
      })
      .mockResolvedValueOnce({
        Parts: page(1001, 1000),
        IsTruncated: true,
        NextPartNumberMarker: '2000',
      })
      .mockResolvedValueOnce({ Parts: page(2001, 5), IsTruncated: false });

    const parts = await provider.listParts('key', 'upload-1');

    expect(parts).toHaveLength(2005);
    expect(parts[0].partNumber).toBe(1);
    expect(parts[2004].partNumber).toBe(2005);
    expect(client.send).toHaveBeenCalledTimes(3);

    // Page one asks with no marker; each later page asks from where the last
    // one stopped. Getting this wrong re-reads page one forever.
    const markers = client.send.mock.calls.map(
      ([command]: [ListPartsCommand]) => command.input.PartNumberMarker,
    );
    expect(markers).toEqual([undefined, '1000', '2000']);
  });

  it('passes the bucket, key and upload id through', async () => {
    const { provider, client } = createProvider();

    client.send.mockResolvedValueOnce({ Parts: [], IsTruncated: false });

    await provider.listParts('uploads/1/a.m4a', 'upload-xyz');

    const command: ListPartsCommand = client.send.mock.calls[0][0];

    expect(command).toBeInstanceOf(ListPartsCommand);
    expect(command.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'uploads/1/a.m4a',
      UploadId: 'upload-xyz',
    });
  });

  it('returns an empty list for an upload with no parts yet', async () => {
    const { provider, client } = createProvider();

    client.send.mockResolvedValueOnce({ IsTruncated: false });

    await expect(provider.listParts('key', 'upload-1')).resolves.toEqual([]);
  });

  it('sorts ascending even if a provider answers out of order', async () => {
    const { provider, client } = createProvider();

    client.send.mockResolvedValueOnce({
      Parts: [
        { PartNumber: 3, Size: 1, ETag: 'c' },
        { PartNumber: 1, Size: 1, ETag: 'a' },
        { PartNumber: 2, Size: 1, ETag: 'b' },
      ],
      IsTruncated: false,
    });

    const parts = await provider.listParts('key', 'upload-1');

    expect(parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
  });

  it('skips an entry with no part number, which nothing could complete with', async () => {
    const { provider, client } = createProvider();

    client.send.mockResolvedValueOnce({
      Parts: [{ Size: 1, ETag: 'a' }, { PartNumber: 2, Size: 1, ETag: 'b' }],
      IsTruncated: false,
    });

    const parts = await provider.listParts('key', 'upload-1');

    expect(parts).toHaveLength(1);
    expect(parts[0].partNumber).toBe(2);
  });

  it('stops rather than looping when a truncated page carries no marker', async () => {
    const { provider, client } = createProvider();

    client.send.mockResolvedValue({ Parts: page(1, 2), IsTruncated: true });

    const parts = await provider.listParts('key', 'upload-1');

    expect(parts).toHaveLength(2);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  // Propagated, never swallowed: a caller told "no parts" by a provider that
  // could not answer would upload the entire file again.
  it('propagates a provider failure', async () => {
    const { provider, client } = createProvider();

    client.send.mockRejectedValueOnce(new Error('NoSuchUpload'));

    await expect(provider.listParts('key', 'upload-1')).rejects.toThrow(
      'NoSuchUpload',
    );
  });
});
