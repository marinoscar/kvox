import type { Page, Route } from '@playwright/test';

import { onboardingResponse } from './onboardingApi';

/**
 * `/api` stubs for the Knowledge graph settings page (issue #369, epic #346).
 *
 * Deterministic by construction: fixed timestamps, a fixed ontology payload
 * (hand-copied from what `computeEffectiveSchema` returns for `core` + `work`,
 * trimmed to the fields the page reads), and a fixed set of the user's own
 * attribute definitions covering every chip the browser draws.
 */

const FIXED_ISO = '2024-03-01T09:00:00.000Z';

function attribute(key: string, label: string, source: 'builtin' | 'mixin' = 'builtin') {
  return {
    key,
    label,
    kind: 'text',
    required: false,
    list: false,
    options: null,
    extractable: true,
    description: label,
    sensitivity: 'business',
    source,
    domain: source === 'mixin' ? 'work' : 'core',
    attributeDefId: null,
    deprecated: false,
    sortOrder: 0,
  };
}

function entityType(key: string, label: string, attributes: unknown[], domain = 'core') {
  return {
    key,
    domain,
    label,
    pluralLabel: `${label}s`,
    description: label,
    disambiguation: [],
    storage: 'entity',
    itemKind: null,
    statuses: null,
    subjectTypes: null,
    subjectRequired: false,
    sensitivityDefault: key === 'Person' ? 'personal' : 'business',
    alignment: null,
    extractable: true,
    deprecated: false,
    attributes,
  };
}

const ONTOLOGY = {
  version: '1.0.0',
  domains: [
    { key: 'core', label: 'Core', enabled: true, alwaysOn: true },
    { key: 'work', label: 'Work', enabled: true, alwaysOn: false },
  ],
  entityTypes: [
    entityType('Person', 'Person', [attribute('title', 'Job title', 'mixin')]),
    entityType('Organization', 'Organization', [attribute('website', 'Website')]),
    entityType('Meeting', 'Meeting', [attribute('topics', 'Topics')]),
    entityType('Project', 'Project', [attribute('status', 'Status')], 'work'),
  ],
  relationTypes: [],
};

function def(overrides: Record<string, unknown>) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    entityType: 'Person',
    key: 'u_nickname01',
    label: 'Nickname',
    kind: 'text',
    options: null,
    extractable: true,
    extractionHint: 'How teammates address them informally',
    sensitivity: null,
    sortOrder: 0,
    deprecatedAt: null,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  };
}

const ATTRIBUTE_DEFS = [
  def({}),
  def({
    id: '66666666-6666-4666-8666-666666666666',
    key: 'u_oldfield01',
    label: 'Desk number',
    extractable: false,
    extractionHint: null,
    deprecatedAt: FIXED_ISO,
  }),
  def({
    id: '77777777-7777-4777-8777-777777777777',
    entityType: 'Organization',
    key: 'u_industry01',
    label: 'Industry',
    kind: 'select',
    options: { choices: [{ value: 'saas', label: 'SaaS' }] },
    extractable: false,
    extractionHint: null,
    sensitivity: 'business',
  }),
];

function json(route: Route, data: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data }),
  });
}

export interface GraphApiOptions {
  /** Answer `GET /api/ai/config` with `graphEnabled: false`. */
  graphDisabled?: boolean;
}

export async function installGraphApi(page: Page, options: GraphApiOptions = {}): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');

    if (path === '/ai/config') {
      return json(route, {
        available: true,
        provider: 'openai',
        providerLabel: 'OpenAI',
        models: [],
        defaultModel: 'gpt-4o-mini',
        maxInputTokens: 100_000,
        maxOutputTokens: 8_000,
        keyConfigured: true,
        graphEnabled: !options.graphDisabled,
      });
    }
    if (path === '/graph/ontology') return json(route, ONTOLOGY);
    if (path === '/graph/attribute-defs') return json(route, { items: ATTRIBUTE_DEFS });

    const onboarding = onboardingResponse(path);
    if (onboarding) return json(route, onboarding);

    return json(route, {});
  });
}
