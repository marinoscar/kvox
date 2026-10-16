import { describeTranscription } from './host';

function resolverReturning(value: unknown) {
  return { resolveSystem: jest.fn().mockResolvedValue(value) };
}

describe('describeTranscription', () => {
  it('reads the transcription system namespace', async () => {
    const resolver = resolverReturning({ provider: 'assemblyai', providers: { assemblyai: { speechModel: 'best' } } });

    await describeTranscription(resolver);

    expect(resolver.resolveSystem).toHaveBeenCalledWith('transcription');
  });

  it('reports the provider id and its model', async () => {
    const resolver = resolverReturning({
      provider: 'assemblyai',
      providers: { assemblyai: { speechModel: 'best' }, other: { speechModel: 'ignored' } },
    });

    await expect(describeTranscription(resolver)).resolves.toEqual({ provider: 'assemblyai', model: 'best' });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('reports provider "none" when the provider is %s', async (_name, provider) => {
    await expect(describeTranscription(resolverReturning({ provider }))).resolves.toEqual({ provider: 'none' });
  });

  it('reports provider "none" when the namespace is absent', async () => {
    await expect(describeTranscription(resolverReturning(undefined))).resolves.toEqual({ provider: 'none' });
  });

  it('reports the provider alone when it has no model', async () => {
    await expect(
      describeTranscription(resolverReturning({ provider: 'assemblyai', providers: { assemblyai: {} } })),
    ).resolves.toEqual({ provider: 'assemblyai' });
    await expect(describeTranscription(resolverReturning({ provider: 'assemblyai' }))).resolves.toEqual({
      provider: 'assemblyai',
    });
  });

  it('ignores a model that is not a non-empty string', async () => {
    for (const speechModel of ['', 7, null, {}]) {
      await expect(
        describeTranscription(resolverReturning({ provider: 'assemblyai', providers: { assemblyai: { speechModel } } })),
      ).resolves.toEqual({ provider: 'assemblyai' });
    }
  });

  it('reports the provider id and model only, never a key or any other setting', async () => {
    const secret = 'sk-live-do-not-leak';
    const resolver = resolverReturning({
      provider: 'assemblyai',
      enabled: true,
      apiKey: secret,
      providers: { assemblyai: { speechModel: 'best', apiKey: secret, region: 'eu', webhookSecret: secret } },
    });

    const facts = await describeTranscription(resolver);

    expect(Object.keys(facts).sort()).toEqual(['model', 'provider']);
    expect(JSON.stringify(facts)).not.toContain(secret);
    expect(JSON.stringify(facts)).not.toContain('eu');
  });

  it('reports nothing before the platform has handed over its settings resolver', async () => {
    await expect(describeTranscription(null)).resolves.toEqual({});
  });
});
