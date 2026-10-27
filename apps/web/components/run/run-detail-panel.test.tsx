import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RunDetailPanel } from './run-detail-panel';
import type { CatalogState } from './history';

const LOADING: CatalogState = { kind: 'loading' };

describe('RunDetailPanel', () => {
  it('renders the back link and a loading state, before any fetch resolves', () => {
    // `renderToStaticMarkup` never runs effects, so `GET /api/runs/:id` has not been called yet —
    // the same first-paint property `projects-screen.test.tsx` exercises.
    const html = renderToStaticMarkup(
      <RunDetailPanel
        runId="a1111111-1111-4111-8111-111111111111"
        backHref="/runs"
        catalogs={{ agents: LOADING, projects: LOADING, users: LOADING, workspaces: LOADING }}
      />,
    );
    expect(html).toContain('Back to Runs');
    expect(html).toContain('Loading run');
  });

  it('keeps every detail definition list stackable instead of fixing a mobile-width label column', async () => {
    const { readFile } = await import('node:fs/promises');
    const [detailSource, liveSource] = await Promise.all([
      readFile(new URL('./run-detail-panel.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./run-view.tsx', import.meta.url), 'utf8'),
    ]);
    expect(`${detailSource}\n${liveSource}`).not.toMatch(/grid-cols-\[\d+px_1fr\]/u);
    expect(detailSource.match(/className=\{DETAIL_KV\}/gu)).toHaveLength(3);
    expect(detailSource).toContain('sm:grid-cols-[140px_minmax(0,1fr)]');
    expect(liveSource).toContain('sm:grid-cols-[150px_minmax(0,1fr)]');
    expect(liveSource).toContain('sm:grid-cols-[105px_minmax(0,1fr)]');
    expect(detailSource).toContain('[overflow-wrap:anywhere]');
    expect(liveSource).toContain('[overflow-wrap:anywhere]');
  });
});
