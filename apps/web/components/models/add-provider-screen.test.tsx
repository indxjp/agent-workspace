import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

const { AddProviderScreen } = await import('./add-provider-screen');
const { editableConfigFields, isProviderFormComplete } = await import('./model');

describe('AddProviderScreen', () => {
  // `renderToStaticMarkup` runs no effects or events, so this is the first paint: `anthropic`,
  // which allows an optional Base URL but, before this screen read the contracts rules, showed none.
  it('offers an optional Base URL for the default Anthropic provider', () => {
    const html = renderToStaticMarkup(<AddProviderScreen />);
    expect(html).toContain('Base URL (optional)');
    expect(html).not.toContain('Deployment');
  });

  it('renders an optional Base URL and no Deployment for anthropic-compatible', () => {
    const html = renderToStaticMarkup(<AddProviderScreen initialProvider="anthropic-compatible" />);
    expect(html).toContain('Base URL (optional)');
    expect(html).not.toContain('Deployment');
    expect(html).toMatch(/<h2[^>]*>Anthropic-compatible endpoint<\/h2>/);
  });

  it('lets an anthropic-compatible connection be saved without a Base URL', () => {
    expect(editableConfigFields('anthropic-compatible')).toContain('baseUrl');
    expect(
      isProviderFormComplete({
        name: 'Gateway',
        provider: 'anthropic-compatible',
        apiKey: 'k',
        baseUrl: '',
        deployment: '',
        apiVersion: '',
      }),
    ).toBe(true);
  });
});
