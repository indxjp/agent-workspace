import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('Wave 7 packaging and documentation surface', () => {
  it('keeps the public README headings in order', () => {
    const headings = [...read('README.md').matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
    expect(headings).toEqual([
      'Why Agent Workspace',
      'Quickstart (60 seconds)',
      'Architecture',
      'Self-host',
      'Packages',
      'Documentation',
      'Contributing',
      'Security',
      'Community and support',
      'License',
    ]);
  });

  it('transcribes the published quick-start commands and names the published packages', () => {
    const readme = read('README.md');
    expect(readme).toContain(
      'npm create @indx-workspace@latest my-agent-platform -- --cloud local\ncd my-agent-platform\npnpm install --frozen-lockfile=false\npnpm start',
    );
    expect(readme).toContain('npx -p @indx-workspace/cli create-agent-workspace my-agent-platform');
    expect(readme).toContain('npx @indx-workspace/aw me');
    for (const name of [
      'contracts',
      'sdk',
      'react',
      'aw',
      'cli',
      'embedded',
      'create',
      'platforms',
    ])
      expect(readme).toContain(`\`@indx-workspace/${name}\``);
    // The wizard, password, port and stop detail lives on the self-hosting page (DOC-12, #1204).
    const source = `${readme}\n${read('docs/sdk/site/building/self-hosting.mdx')}`;
    expect(source).not.toContain('unrelated npm publishers');
    expect(source).toContain('docker buildx');
    expect(source).toContain('http://localhost:3000/setup');
    expect(source).toMatch(/One-time setup\s+password/);
    expect(source).toContain('export AGENT_WORKSPACE_URL=http://localhost:3000');
    expect(source).toContain('`PORT`');
    expect(source).toContain('/admin/api-keys');
    expect(source).toContain('`/signin`');
    expect(source.replace(/\s+/gu, ' ')).toContain('only at step 4');
    expect(source.replace(/\s+/gu, ' ')).toContain('checked when you click "Finish setup"');
    expect(source).toContain('`pnpm stop` (`agent-workspace stop`)');
    expect(source).toContain('pnpm stop --volumes');
    // pnpm forwards a literal `--`; the documented form passes `--volumes` straight through.
    expect(source).not.toContain('pnpm stop -- --volumes');
    expect(source).not.toContain('Settings → API keys');
    expect(source).not.toContain('pnpm db:seed');
    expect(source).toContain('DOCKER_GID');
  });

  it('ships both deployment guides and every programmatic start entry point', () => {
    for (const file of [
      'docs/deploy/single-vm.md',
      'docs/deploy/kubernetes.md',
      'apps/web/server/start.ts',
      'apps/runner/src/start.ts',
      'packages/gateway/src/start.ts',
    ]) {
      expect(existsSync(path.join(root, file)), file).toBe(true);
    }
  });
});
