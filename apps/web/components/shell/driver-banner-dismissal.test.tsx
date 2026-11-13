import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const versions: string[] = [];
vi.mock('./dismissible-notice', () => ({
  DismissibleNotice: ({ version }: { readonly version: string }) => {
    versions.push(version);
    return null;
  },
}));

const { DeploymentDriverBanner } = await import('./driver-banner');

afterEach(() => {
  vi.unstubAllEnvs();
  versions.length = 0;
});

describe('the driver band’s dismissal (UX-15)', () => {
  it('is remembered per driver, not per language, so switching language keeps it dismissed', () => {
    vi.stubEnv('RUNTIME_DRIVER', '');
    renderToStaticMarkup(<DeploymentDriverBanner />);
    renderToStaticMarkup(<DeploymentDriverBanner locale="ja" />);
    vi.stubEnv('RUNTIME_DRIVER', 'local');
    renderToStaticMarkup(<DeploymentDriverBanner locale="ja" />);
    expect(versions).toEqual(['driver=not configured', 'driver=not configured', 'driver=local']);
  });
});
