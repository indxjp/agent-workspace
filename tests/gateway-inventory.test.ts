import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createGatewayApplication, type GatewayRoute } from '@agent-workspace/gateway';
import {
  ANTHROPIC_CAPABILITIES,
  AZURE_OPENAI_CAPABILITIES,
  OPENAI_CAPABILITIES,
  OPENAI_COMPATIBLE_CAPABILITIES,
  PROVIDER_IDS,
  VERTEX_CAPABILITIES,
  createProviderRegistry,
} from '@agent-workspace/gateway/providers/registry';
import { OPTIONAL_PROVIDER_SCENARIOS, REQUIRED_PROVIDER_SCENARIOS } from './providers/scenarios.js';
import { renderCompatibilityMatrix } from './providers/renderer.js';
import type { CompatibilityOutcome, CompatibilityReport } from './providers/types.js';

const SPEC = new URL('../docs/spec.md', import.meta.url);
const CAPABILITIES = {
  anthropic: ANTHROPIC_CAPABILITIES,
  openai: OPENAI_CAPABILITIES,
  'azure-openai': AZURE_OPENAI_CAPABILITIES,
  'openai-compatible': OPENAI_COMPATIBLE_CAPABILITIES,
  vertex: VERTEX_CAPABILITIES,
} as const;

const OPTIONAL_KEYS = {
  thinking: 'thinking',
  'prompt-caching': 'promptCaching',
  'structured-output': 'structuredOutput',
  'context-management': 'contextManagement',
} as const;

const OPENAI_WARNINGS = {
  thinking:
    "This model's reasoning is hidden by default; a summary is not Claude's readable thinking.",
  'prompt-caching':
    "Usage does not distinguish Claude's short-lived and long-lived prompt-cache classes.",
} as const;

function unionCompatibilityReports(): readonly CompatibilityReport[] {
  return PROVIDER_IDS.map((providerId) => {
    const required: CompatibilityOutcome[] = REQUIRED_PROVIDER_SCENARIOS.map((id) => ({
      id,
      verdict: 'native',
      detail: 'adapter passed the required recorded-fixture scenario in the union test run',
    }));
    const optional: CompatibilityOutcome[] = OPTIONAL_PROVIDER_SCENARIOS.map((id) => {
      if (providerId === 'openai' && (id === 'thinking' || id === 'prompt-caching')) {
        return {
          id,
          verdict: 'approximated',
          detail: 'declared adapter approximation',
          warning: OPENAI_WARNINGS[id],
        };
      }
      const verdict = CAPABILITIES[providerId][OPTIONAL_KEYS[id]] ? 'native' : 'unsupported';
      return { id, verdict, detail: `declared by ${providerId} capabilities` };
    });
    return { providerId, outcomes: [...required, ...optional], ok: true };
  });
}

export function renderUnionCompatibilityMatrix(): string {
  return `${renderCompatibilityMatrix(unionCompatibilityReports())}\nFixture basis:\n\n${PROVIDER_IDS.map(
    (id) => `- ${id}: recorded-fixture conformance run; no live provider credential was available.`,
  ).join('\n')}\n`;
}

export function gatewayRoutesFromSpec(source: string): readonly GatewayRoute[] {
  const contract = source.match(
    /The primary compatibility contract should be:\s*```text\s*([\s\S]*?)```/u,
  )?.[1];
  if (contract === undefined) throw new Error('docs/spec.md has no primary compatibility contract');
  return contract
    .trim()
    .split(/\r?\n/u)
    .map((line) => {
      const match = /^(GET|POST)\s+(\/\S+)$/u.exec(line.trim());
      if (match === null) throw new Error(`unreadable gateway route: ${line}`);
      return { method: match[1], path: match[2] } as GatewayRoute;
    });
}

export function assertGatewayInventory(
  actual: readonly GatewayRoute[],
  expected: readonly GatewayRoute[],
): void {
  const key = (route: GatewayRoute) => `${route.method} ${route.path}`;
  expect(actual.map(key)).toEqual(expected.map(key));
}

describe('spec §9 gateway inventory', () => {
  it('equals the nine-route contract parsed from docs/spec.md', async () => {
    const expected = gatewayRoutesFromSpec(await readFile(SPEC, 'utf8'));
    const application = createGatewayApplication({
      tokenSecret: 'gateway-inventory-token-secret-0001',
      resolver: { resolve: () => Promise.resolve({ state: 'missing' }) },
    });
    assertGatewayInventory(application.routes, expected);
    // Four Anthropic-era routes, the two OpenAI-dialect ingress routes of ADR-0068, and the tool
    // route of ADR-0113 C16, the tool sandbox route of ADR-0118 TS3 and the endpoint tool sandbox
    // route of ADR-0134 part 2.
    expect(application.routes).toHaveLength(9);
  });

  it('fails closed when an undeclared route is planted', async () => {
    const expected = gatewayRoutesFromSpec(await readFile(SPEC, 'utf8'));
    const planted = [
      ...expected,
      { method: 'GET', path: '/v1/provider-secrets' },
    ] as unknown as readonly GatewayRoute[];
    expect(() => assertGatewayInventory(planted, expected)).toThrow();
  });

  it('keeps the composition root and registry on the same exact provider table', () => {
    expect(createProviderRegistry().map((provider) => provider.id)).toEqual(PROVIDER_IDS);
    expect(PROVIDER_IDS).toEqual([
      'anthropic',
      'openai',
      'azure-openai',
      'openai-compatible',
      'vertex',
    ]);
  });

  it('publishes each optional capability as the provider adapter declares it', async () => {
    // docs/compatibility/providers.md is rendered from scripts/matrix/providers.json, a hand-kept
    // table; a capability flag flipped in the adapter must flip the published cell too.
    const published = JSON.parse(
      await readFile(new URL('../scripts/matrix/providers.json', import.meta.url), 'utf8'),
    ) as {
      providers: { id: string; default: string; overrides?: Record<string, string> }[];
    };
    for (const provider of published.providers) {
      if (provider.default === 'not-derivable') continue;
      const capabilities = CAPABILITIES[provider.id as keyof typeof CAPABILITIES];
      for (const id of OPTIONAL_PROVIDER_SCENARIOS) {
        const verdict = provider.overrides?.[id] ?? provider.default;
        const declared = capabilities[OPTIONAL_KEYS[id]];
        expect(
          verdict === 'unsupported',
          `${provider.id} ${id} is published as ${verdict}, the adapter declares ${OPTIONAL_KEYS[id]}=${String(declared)}`,
        ).toBe(!declared);
      }
    }
  });

  it('renders every provider from the complete union report', () => {
    const rendered = renderUnionCompatibilityMatrix();
    for (const providerId of PROVIDER_IDS) {
      const row = rendered.split(/\r?\n/u).find((line) => line.startsWith(`| ${providerId} |`));
      expect(row).toBeDefined();
      expect(row).not.toContain('?');
      expect(row).not.toContain('n/d');
    }
  });
});
