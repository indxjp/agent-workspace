/**
 * Counts raw `fetch(` / `fetchJson(` calls per file under `components/**` and `app/**`
 * (excluding `app/api`, `route.ts`, tests and comment lines). The budget may only go down:
 * a new call fails the test, and so does a migrated call whose entry was not lowered.
 * Issue #247 moves each family onto `@indx-workspace/sdk`, lowers or deletes its entries in the
 * same PR, and deletes this test when `BUDGET` is empty.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url));

const BUDGET: Record<string, number> = {
  'app/(shell)/workspaces/workspaces-screen.tsx': 3,
  'components/agents/agent-detail.tsx': 5,
  'components/agents/agent-form.tsx': 5,
  'components/agents/agents-list.tsx': 1,
  'components/agents/resource-editor.tsx': 4,
  'components/composer/home-chat.tsx': 1,
  'components/models/add-provider-screen.tsx': 1,
  'components/models/model-selector.tsx': 2,
  'components/models/models-screen.tsx': 2,
  'components/models/provider-detail.tsx': 5,
  'components/projects/project-detail.tsx': 5,
  'components/projects/project-form.tsx': 3,
  'components/projects/projects-screen.tsx': 3,
  'components/resources/resource-screens.tsx': 14,
  'components/run/history-screen.tsx': 3,
  'components/run/live.ts': 3,
  'components/run/run-detail-panel.tsx': 1,
  'components/setup/setup-wizard.tsx': 2,
  'components/shares/share-dialog.tsx': 1,
  'components/shares/shared-links-screen.tsx': 4,
  'components/shell/workspace-switcher.tsx': 1,
  'components/team/invitations-section.tsx': 4,
  'components/team/team-screen.tsx': 5,
};

function countRawFetches(source: string): number {
  let count = 0;
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    count += line.match(/\bfetch(?:Json)?\(/gu)?.length ?? 0;
  }
  return count;
}

function collectCounts(relativeDir: string, counts: Record<string, number>): void {
  for (const entry of readdirSync(path.join(WEB_ROOT, relativeDir), { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (relativePath !== 'app/api') collectCounts(relativePath, counts);
      continue;
    }
    if (!/\.tsx?$/u.test(entry.name) || /\.test\.tsx?$/u.test(entry.name)) continue;
    if (entry.name === 'route.ts') continue;
    const count = countRawFetches(readFileSync(path.join(WEB_ROOT, relativePath), 'utf8'));
    if (count > 0) counts[relativePath] = count;
  }
}

describe('raw browser fetch budget', () => {
  it('matches the raw fetch budget; lower it when a family moves to the SDK (#247)', () => {
    const counts: Record<string, number> = {};
    collectCounts('components', counts);
    collectCounts('app', counts);
    expect(counts).toEqual(BUDGET);
  });
});
