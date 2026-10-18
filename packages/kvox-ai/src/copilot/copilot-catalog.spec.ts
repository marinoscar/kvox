import { COPILOT_CATALOG, COPILOT_CATALOG_VERSION, copilotCatalogEntry, copilotStructuredOutputMode } from './copilot-catalog.js';

// =============================================================================
// The Copilot fallback catalog (#581)
// =============================================================================

describe('the fallback catalog', () => {
  it('is dated, frozen and holds the four documented models', () => {
    expect(COPILOT_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.isFrozen(COPILOT_CATALOG)).toBe(true);
    expect(COPILOT_CATALOG.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(COPILOT_CATALOG.map((e) => e.id)).toEqual(['gpt-5-mini', 'gpt-4.1', 'claude-sonnet-4.5', 'claude-haiku-4.5']);
    for (const entry of COPILOT_CATALOG) {
      expect(entry.contextWindow).toBeGreaterThan(entry.maxOutputTokens);
      expect(entry.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it('finds an entry by id, in the given catalog', () => {
    expect(copilotCatalogEntry('gpt-4.1')?.label).toBe('GPT-4.1');
    expect(copilotCatalogEntry('nope')).toBeUndefined();
    expect(copilotCatalogEntry('x', [{ id: 'x', label: 'X', contextWindow: 1, maxOutputTokens: 1, structuredOutputMode: 'native' }])?.label).toBe('X');
  });
});

describe('copilotStructuredOutputMode', () => {
  it.each([
    ['gpt-5-mini', 'native'],
    ['gpt-4.1', 'native'],
    ['claude-sonnet-4.5', 'prompted'],
    ['claude-haiku-4.5', 'prompted'],
    // Unknown ids: native only when the id looks OpenAI-shaped.
    ['gpt-9-future', 'native'],
    ['GPT-5.9', 'native'],
    ['o3', 'native'],
    ['o4-mini', 'native'],
    ['gemini-2.5-pro', 'prompted'],
    ['claude-opus-9', 'prompted'],
    ['other', 'prompted'],
    ['', 'prompted'],
  ] as const)('%s is %s', (id, mode) => {
    expect(copilotStructuredOutputMode(id)).toBe(mode);
  });

  it('lets a catalog entry override the id heuristic', () => {
    const catalog = [{ id: 'gpt-weird', label: 'W', contextWindow: 2, maxOutputTokens: 1, structuredOutputMode: 'prompted' as const }];
    expect(copilotStructuredOutputMode('gpt-weird', catalog)).toBe('prompted');
    expect(copilotStructuredOutputMode('gpt-5-mini', catalog)).toBe('native');
  });
});
