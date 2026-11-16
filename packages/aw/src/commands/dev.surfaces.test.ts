import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { tempFile } from '../testing.js';
import { TOKEN, PROJECT_URL, DEFINE, READY, dev, synced } from './dev.test-support.js';
import { projectWithAgent, agentsRoute } from './dev.routes.test-support.js';

describe('aw dev (issue #451): syncs agents and surfaces', () => {
  it('syncs agents/ and surfaces/ after sign-in and prints the widget line last (issue #453)', async () => {
    const cwd = await projectWithAgent();
    await tempFile(
      cwd,
      'surfaces/main.ts',
      `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });\n`,
    );
    const { run } = await dev(cwd, {
      route: agentsRoute,
      until: synced,
    });

    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    // The ready screen carries the try page and the widget, so the first sync does not repeat them.
    expect(run.stdout).toContain('    agent     assistant  (agents/assistant.ts)\n');
    expect(run.stdout).toContain('    surface   main\n');
    expect(run.stdout).toContain(`  try       ${PROJECT_URL}/p/s/main/try\n`);
    expect(run.stdout).toContain(
      `  embed     <script src="${PROJECT_URL}/p/s/main/widget.js" async></script>\n`,
    );
    expect(run.stdout).not.toContain('page: ');
    expect(run.stdout).not.toContain('widget: ');
    expect(run.stdout.endsWith('synced: "assistant" created at version 1\n')).toBe(true);
    // A dry run and the create, both to the runtime aw dev started, with its own credential.
    const posts = run.calls.filter(
      (call) => call.url.pathname === '/api/agents' && call.method === 'POST',
    );
    expect(
      posts.map((call) => `${call.url.origin} ${call.headers.get('authorization') ?? ''}`),
    ).toEqual([`${PROJECT_URL} Bearer ${TOKEN}`, `${PROJECT_URL} Bearer ${TOKEN}`]);
    expect(run.stdout + run.stderr).not.toContain('ak_live_');
  });

  it('prints the try URL and embed tag of every surface, the first on the ready screen', async () => {
    const cwd = await projectWithAgent();
    for (const name of ['main', 'second']) {
      await tempFile(
        cwd,
        `surfaces/${name}.ts`,
        `${DEFINE}export default defineSurface({ name: '${name}', agent: 'assistant' });
`,
      );
    }
    const { run } = await dev(cwd, { route: agentsRoute, until: synced });

    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stdout).toContain(`  try       ${PROJECT_URL}/p/s/main/try
`);
    expect(run.stdout).not.toContain(`try: ${PROJECT_URL}/p/s/main/try
`);
    expect(run.stdout).toContain(`try: ${PROJECT_URL}/p/s/second/try
`);
    expect(run.stdout).toContain(`widget: <script src="${PROJECT_URL}/p/s/second/widget.js"`);
  });
});

describe('aw dev (issue #451): shows the ready screen', () => {
  it('shows no evals row without eval files, and the case total with them', async () => {
    const without = await projectWithAgent();
    const none = await dev(without, { route: agentsRoute, until: synced });
    expect(none.run.stdout).not.toContain('npx aw eval');

    const cwd = await projectWithAgent();
    const cases = (count: number): string =>
      `cases:
${Array.from(
  { length: count },
  (_, i) => `  - name: c${String(i)}
    input: hi
    expect: { contains: [hi] }
`,
).join('')}`;
    await tempFile(cwd, 'evals/A.yaml', cases(2));
    await tempFile(cwd, 'evals/B.yaml', cases(1));
    const { run } = await dev(cwd, { route: agentsRoute, until: synced });
    expect(run.stdout).toContain('  evals     3 cases · npx aw eval\n');
  }, 30_000);

  it('points the page, try and widget lines at the URL the runtime said it is ready on', async () => {
    const readyUrl = 'http://localhost:3000';
    const cwd = await projectWithAgent({ ...READY, url: `${readyUrl}/` });
    await tempFile(
      cwd,
      'surfaces/main.ts',
      `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });\n`,
    );
    const { run } = await dev(cwd, {
      route: agentsRoute,
      until: synced,
    });

    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stdout).toContain(`  try       ${readyUrl}/p/s/main/try\n`);
    expect(run.stdout).toContain(
      `  embed     <script src="${readyUrl}/p/s/main/widget.js" async></script>\n`,
    );
  });
});
