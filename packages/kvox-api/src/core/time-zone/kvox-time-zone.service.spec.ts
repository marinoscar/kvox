import { KvoxTimeZoneService } from './kvox-time-zone.service.js';
import type { KvoxSettingsPort } from '../../ports/index.js';

const portWith = (zone: string | null | (() => never)): KvoxSettingsPort =>
  ({
    readUserTimeZone: async () => (typeof zone === 'function' ? zone() : zone),
  }) as unknown as KvoxSettingsPort;

describe('KvoxTimeZoneService', () => {
  it('prefers the stored zone over the header', async () => {
    const zones = new KvoxTimeZoneService(portWith('America/Chicago'));
    expect(await zones.forRequest('u', 'Asia/Tokyo')).toBe('America/Chicago');
  });

  it('falls back to a valid header for a user on Automatic, then to UTC', async () => {
    const zones = new KvoxTimeZoneService(portWith(null));
    expect(await zones.forRequest('u', 'Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(await zones.forRequest('u', 'Not/AZone')).toBe('UTC');
    expect(await zones.forRequest('u', undefined)).toBe('UTC');
    expect(await zones.forUser('u')).toBe('UTC');
  });

  it('ignores an invalid stored zone and never throws when the port does', async () => {
    expect(await new KvoxTimeZoneService(portWith('Not/AZone')).forRequest('u', 'Asia/Tokyo')).toBe('Asia/Tokyo');
    const broken = portWith(() => {
      throw new Error('db down');
    });
    expect(await new KvoxTimeZoneService(broken).forRequest('u', 'Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  it('answers UTC when no settings port is bound', async () => {
    expect(await new KvoxTimeZoneService().forRequest('u', undefined)).toBe('UTC');
  });
});
