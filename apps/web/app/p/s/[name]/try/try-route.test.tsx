/**
 * `GET /p/s/<name>/try` through its page (ADR-0105 slice 1; S1-18, issue #456): served only where
 * the surface page and its loader are, and printing the origin the page was asked on. The runtime
 * is `server/surfaces/loader/test-runtime.ts`'s; `next/headers` answers with the request's headers
 * and `notFound()` throws, as Next.js's does.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installWidgetSurfaceRuntime,
  WIDGET_WORKSPACE_SLUG,
} from '../../../../../server/surfaces/loader/test-runtime';
import { clearSurfaceSessionsRuntime } from '../../../../../server/surfaces/public/runtime';

const request = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(request.headers),
}));

vi.mock('next/navigation', () => ({
  notFound: (): never => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const { default: SurfaceTryPage } = await import('./page');

async function open(name: string, headers: Record<string, string>): Promise<string> {
  request.headers = new Headers(headers);
  return renderToStaticMarkup(await SurfaceTryPage({ params: Promise.resolve({ name }) }));
}

beforeEach(async () => {
  vi.stubEnv('AW_LOCAL_SURFACE_SESSIONS', '1');
  vi.stubEnv('HOST', '127.0.0.1');
  vi.stubEnv('BOOTSTRAP_ADMIN', 'admin@example.com');
  vi.stubEnv('BOOTSTRAP_ADMIN_PASSWORD', 'correct-horse-battery');
  vi.stubEnv('WORKSPACE_SLUG', WIDGET_WORKSPACE_SLUG);
  await installWidgetSurfaceRuntime();
});

afterEach(() => {
  clearSurfaceSessionsRuntime();
  vi.unstubAllEnvs();
});

describe('GET /p/s/<name>/try (S1-18, #456)', () => {
  it('prints the one tag with the origin the page was asked on', async () => {
    const html = await open('main', { host: '127.0.0.1:4310' });
    expect(html).toContain('http://127.0.0.1:4310/p/s/main/widget.js');
    expect(html).toContain('data-surface-try="main"');
    expect(html).toContain('data-surface="main"');
    // Issue #612: the fixture agent has only a `local` pointer, so the page says so.
    expect(html).toContain('data-surface-not-promoted');

    const secure = await open('main', { host: 'localhost:4310', 'x-forwarded-proto': 'https' });
    expect(secure).toContain('https://localhost:4310/p/s/main/widget.js');
  });

  it('shows no model banner when a first message would be accepted', async () => {
    expect(await open('main', { host: '127.0.0.1:4310' })).not.toContain(
      'data-surface-model-refusal',
    );
  });

  // Issue #661: the first screen names the fix before anything is sent.
  it('names the fix before the first message when the model key is missing', async () => {
    await installWidgetSurfaceRuntime({
      code: 'model_connection_unresolved',
      message: 'no model connection.',
    });
    vi.stubEnv('AW_LOCAL_MODEL_SECRETS', '["MAIN_MODEL_KEY"]');
    const html = await open('main', { host: '127.0.0.1:4310' });
    expect(html).toContain('data-surface-model-refusal="model_connection_unresolved"');
    expect(html).toContain('no model connection.');
    // The fixture surface is Japanese; the card names the project's own secret.
    // MAIN_MODEL_KEY is not the Anthropic key, so no Anthropic console link.
    expect(html).not.toContain('API キーを取得する');
    expect(html).toContain('MAIN_MODEL_KEY=');
  });

  it('falls back to ANTHROPIC_API_KEY when the secret names are absent or unreadable', async () => {
    await installWidgetSurfaceRuntime({ code: 'model_credential_rejected', message: 'rejected.' });
    vi.stubEnv('AW_LOCAL_MODEL_SECRETS', 'not json');
    expect(await open('main', { host: '127.0.0.1:4310' })).toContain('ANTHROPIC_API_KEY');
  });

  it('is the 404 page for a surface no pointer serves', async () => {
    await expect(open('billing', { host: '127.0.0.1:4310' })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('is the 404 page when asked over a host that is not loopback', async () => {
    await expect(open('main', { host: 'example.com' })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('is the 404 page off the local runtime', async () => {
    vi.stubEnv('AW_LOCAL_SURFACE_SESSIONS', '');
    await expect(open('main', { host: '127.0.0.1:4310' })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
