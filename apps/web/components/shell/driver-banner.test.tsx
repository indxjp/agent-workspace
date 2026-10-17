import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeploymentDriverBanner, DriverBanner } from './driver-banner';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DriverBanner', () => {
  it('renders the setup wizard band without a dismiss button', () => {
    const html = renderToStaticMarkup(
      <DriverBanner driver="local" reason="No tenant isolation" warning />,
    );
    expect(html).toContain('data-testid="driver-in-force"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('No tenant isolation');
    expect(html).not.toContain('aria-label="Dismiss"');
  });
});

describe('DeploymentDriverBanner', () => {
  it('makes the local isolation warning a dismissible, machine-readable alert', () => {
    vi.stubEnv('RUNTIME_DRIVER', 'local');
    const html = renderToStaticMarkup(<DeploymentDriverBanner />);
    expect(html).toContain('data-testid="driver-in-force"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('bg-warn-soft');
    expect(html).toContain('No tenant isolation: commands run as the host user');
    expect(html).toContain('aria-label="Dismiss"');
  });

  it('asks for a runtime when none is configured', () => {
    vi.stubEnv('RUNTIME_DRIVER', '');
    const html = renderToStaticMarkup(<DeploymentDriverBanner />);
    expect(html).toContain('role="status"');
    expect(html).toContain('<b>not configured</b>');
    expect(html).toContain('Choose and test a runtime');
    expect(html).toContain('aria-label="Dismiss"');
  });

  it('renders no band for a configured driver other than local', () => {
    vi.stubEnv('RUNTIME_DRIVER', 'docker');
    expect(renderToStaticMarkup(<DeploymentDriverBanner />)).toBe('');
  });

  it('keeps the band without a dismiss button where no top bar chip exists', () => {
    vi.stubEnv('RUNTIME_DRIVER', 'local');
    const html = renderToStaticMarkup(<DeploymentDriverBanner dismissible={false} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('No tenant isolation: commands run as the host user');
    expect(html).not.toContain('aria-label="Dismiss"');
  });
});
