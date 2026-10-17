import { describe, expect, it } from 'vitest';

import { kvoxTranscriptionAdminSections, kvoxTranscriptionRoutes } from '../../src/transcription/ui/index.js';

describe('the transcription slice data', () => {
  it('declares one admin card with the exact permission the controller enforces', () => {
    expect(kvoxTranscriptionAdminSections.general).toHaveLength(1);
    const [card] = kvoxTranscriptionAdminSections.general;
    expect(card).toMatchObject({
      title: 'Transcription',
      path: '/admin/settings/transcription',
      permission: 'system_settings:read',
    });
    // The icon is a component, never a rendered element: the hub and the rail draw it at different sizes.
    expect(typeof card?.Icon === 'function' || typeof card?.Icon === 'object').toBe(true);
    expect(card).not.toHaveProperty('feature');
  });

  it('declares one route on the same path and permission as the card', () => {
    const [route] = kvoxTranscriptionRoutes;
    const [card] = kvoxTranscriptionAdminSections.general;

    expect(kvoxTranscriptionRoutes).toHaveLength(1);
    expect(route?.path).toBe(card?.path);
    expect(route?.permission).toBe(card?.permission);
    expect(route?.Component).toBeDefined();
  });
});
