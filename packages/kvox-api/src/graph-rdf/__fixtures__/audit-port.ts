import type { KvoxAuditPort } from '../../ports/index.js';

/**
 * An audit port that writes through a mocked `prisma.auditEvent.create`, so a spec that asserts
 * on the old call shape (`{ data: event }`) keeps its assertions.
 *
 * @param prisma - the mock holding `auditEvent.create`.
 * @returns the port.
 */
export function auditPortOver(prisma: {
  auditEvent: { create: (args: { data: any }) => unknown };
}): KvoxAuditPort {
  return {
    record: async (event) => {
      await prisma.auditEvent.create({ data: event });
    },
  };
}
