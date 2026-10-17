import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

function trackedDeclarations(): string[] {
  return execFileSync('git', ['ls-files', 'tests/screen-declarations/*.ts'], {
    cwd: root,
    encoding: 'utf8',
  })
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
}

describe('A.3 driver-in-force banner', () => {
  it('covers every shipped screen through the shared shell or the explicit setup seam', () => {
    const shippedPages = trackedDeclarations().flatMap((file) => {
      const source = readFileSync(path.join(root, file), 'utf8');
      if (!source.includes("status: 'shipped'")) return [];
      return [...source.matchAll(/page:\s*'([^']+)'/gu)].map((match) => match[1] as string);
    });
    expect(shippedPages.length).toBeGreaterThan(0);
    const seams = new Map([
      ['apps/web/app/setup/page.tsx', 'apps/web/components/setup/setup-wizard.tsx'],
      ['apps/web/app/signin/page.tsx', 'apps/web/app/signin/layout.tsx'],
      ['apps/web/app/p/[token]/page.tsx', 'apps/web/app/p/[token]/layout.tsx'],
      // The hosted surface and its try page draw the banner inside the chat's frame (#558).
      ['apps/web/app/p/s/[name]/page.tsx', 'apps/web/app/p/s/[name]/page.tsx'],
      ['apps/web/app/p/s/[name]/try/page.tsx', 'apps/web/app/p/s/[name]/try/page.tsx'],
    ]);
    expect(shippedPages.filter((page) => !page.includes('/(shell)/') && !seams.has(page))).toEqual(
      [],
    );

    const shell = readFileSync(path.join(root, 'apps/web/app/(shell)/layout.tsx'), 'utf8');
    expect(shell).toContain('<DeploymentDriverBanner');
    for (const seam of new Set(seams.values())) {
      const source = readFileSync(path.join(root, seam), 'utf8');
      expect(source).toMatch(/<(?:Deployment)?DriverBanner/u);
    }
  });
});
