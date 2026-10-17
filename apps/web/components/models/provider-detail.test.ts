import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { readModelConnections, type ModelConnectionView } from './model';
import { ProviderDetailPanel } from './provider-detail';

const NOOP = (): void => {
  /* the panel's callbacks are exercised through the pure functions in model.test.ts; this render
   * test only asserts what the initial markup contains. */
};

function connection(
  overrides: Partial<Parameters<typeof readModelConnections>[0]>,
): ModelConnectionView {
  const [parsed] = readModelConnections({
    models: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Prod Claude',
        provider: 'anthropic',
        config: {},
        hasCredential: true,
        ready: true,
        ...overrides,
      },
    ],
  });
  if (parsed === undefined) throw new Error('fixture connection failed to parse');
  return parsed;
}

describe('ProviderDetailPanel', () => {
  it('never renders a credential — the rotate field starts empty, not pre-filled from the connection', () => {
    const html = renderToStaticMarkup(
      createElement(ProviderDetailPanel, {
        connection: connection({}),
        onUpdated: NOOP,
        onRemoved: NOOP,
        onClose: NOOP,
      }),
    );
    expect(html).toContain('New API key');
    expect(html).toContain('type="password"');
    // The one input that could ever carry a credential renders with no `value` content: nothing in
    // `ModelConnectionView` could have supplied one, because the wire contract never sends one.
    expect(html).not.toMatch(/type="password"[^>]*value="[^"]+"/u);
  });

  it("shows only the fields the connection's provider allows: anthropic gets Base URL and nothing else", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderDetailPanel, {
        connection: connection({ provider: 'anthropic' }),
        onUpdated: NOOP,
        onRemoved: NOOP,
        onClose: NOOP,
      }),
    );
    expect(html).toContain('Base URL');
    expect(html).not.toContain('Deployment');
    expect(html).not.toContain('API version');
  });

  it('shows Base URL, Deployment and API version for azure-openai, pre-filled from the saved config', () => {
    const html = renderToStaticMarkup(
      createElement(ProviderDetailPanel, {
        connection: connection({
          provider: 'azure-openai',
          config: {
            baseUrl: 'https://company.openai.azure.com',
            deployment: 'gpt-41',
            apiVersion: '2024-06-01',
          },
        }),
        onUpdated: NOOP,
        onRemoved: NOOP,
        onClose: NOOP,
      }),
    );
    expect(html).toContain('Base URL');
    expect(html).toContain('Deployment');
    expect(html).toContain('API version');
    expect(html).toContain('https://company.openai.azure.com');
    expect(html).toContain('gpt-41');
    expect(html).toContain('2024-06-01');
  });

  it('names the derived status next to the rotate control, not a hardcoded "Connected"', () => {
    const html = renderToStaticMarkup(
      createElement(ProviderDetailPanel, {
        connection: connection({ hasCredential: true, ready: false }),
        onUpdated: NOOP,
        onRemoved: NOOP,
        onClose: NOOP,
      }),
    );
    expect(html).toContain('Configuration incomplete');
  });

  it('starts with the remove confirmation closed, so no fetch to preview or delete has happened yet', () => {
    const html = renderToStaticMarkup(
      createElement(ProviderDetailPanel, {
        connection: connection({}),
        onUpdated: NOOP,
        onRemoved: NOOP,
        onClose: NOOP,
      }),
    );
    expect(html).toContain('Remove connection…');
    expect(html).not.toContain('Type');
  });
});
