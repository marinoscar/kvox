import { systemMaintenanceSchema } from '../../schemas/settings.schema';
import { updateMaintenanceSchema } from './update-maintenance.dto';

describe('updateMaintenanceSchema', () => {
  it('requires `enabled` — the question the endpoint exists to answer', () => {
    expect(updateMaintenanceSchema.safeParse({}).success).toBe(false);
    expect(updateMaintenanceSchema.safeParse({ enabled: true }).success).toBe(
      true,
    );
  });

  it('accepts an optional message and allowAdmins', () => {
    const parsed = updateMaintenanceSchema.parse({
      enabled: true,
      message: 'Back at 03:00 UTC',
      allowAdmins: false,
    });

    expect(parsed).toEqual({
      enabled: true,
      message: 'Back at 03:00 UTC',
      allowAdmins: false,
    });
  });

  it('enforces exactly the stored namespace’s message bounds', () => {
    // Derived from `systemMaintenanceSchema`, never restated: a second copy of
    // `.max(1000)` here would be free to drift from the one the system-settings
    // PUT/PATCH enforce on the same field.
    expect(updateMaintenanceSchema.safeParse({ enabled: true, message: '' }).success).toBe(
      false,
    );
    expect(
      updateMaintenanceSchema.safeParse({
        enabled: true,
        message: 'x'.repeat(1001),
      }).success,
    ).toBe(false);
    expect(
      updateMaintenanceSchema.safeParse({
        enabled: true,
        message: 'x'.repeat(1000),
      }).success,
    ).toBe(true);

    // And the bound is the SAME object, so this cannot pass while the stored
    // schema disagrees.
    expect(systemMaintenanceSchema.shape.message.safeParse('').success).toBe(false);
  });

  it('rejects a non-boolean enabled rather than coercing it', () => {
    expect(updateMaintenanceSchema.safeParse({ enabled: 'true' }).success).toBe(
      false,
    );
  });

  it('refuses to let a caller dictate the window’s provenance', () => {
    // `startedAt` / `startedById` are stamped by the service when it opens a
    // window. An audit trail the audited party can write is not one.
    const parsed = updateMaintenanceSchema.parse({
      enabled: true,
      startedAt: '2020-01-01T00:00:00.000Z',
      startedById: '44444444-4444-4444-8444-444444444444',
    });

    expect(parsed).not.toHaveProperty('startedAt');
    expect(parsed).not.toHaveProperty('startedById');
  });
});
