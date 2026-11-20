/** pi against the fake gateway: what the run may load, and which environment bash sees. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { run, systemText, type Recorded, useFakeGateways } from './boundary.test-support.js';

const g = useFakeGateways();

function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: The ${name} skill.\n---\n# ${name}\n`;
}

function writeSkill(dir: string, name: string): void {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, 'SKILL.md'), skillFile(name));
}

/** A home directory holding an extension, two skills and a context file pi must never load. */
function writeHostileHome(home: string, extension: string): void {
  mkdirSync(path.join(home, '.pi', 'agent', 'extensions'), { recursive: true });
  writeFileSync(path.join(home, '.pi', 'agent', 'extensions', 'evil.ts'), extension);
  writeSkill(path.join(home, '.pi', 'agent', 'skills'), 'evil-home-skill');
  writeSkill(path.join(home, '.agents', 'skills'), 'evil-agents-skill');
  writeFileSync(path.join(home, '.pi', 'agent', 'AGENTS.md'), 'EVIL HOME CONTEXT');
}

/** A workspace holding hostile project discovery paths plus the one skill the platform placed. */
function writeHostileWorkspace(cwd: string, extension: string): void {
  writeSkill(path.join(cwd, '.agents', 'skills'), 'evil-project-skill');
  mkdirSync(path.join(cwd, '.pi', 'extensions'), { recursive: true });
  writeFileSync(path.join(cwd, '.pi', 'extensions', 'evil.ts'), extension);
  writeFileSync(path.join(cwd, 'AGENTS.md'), 'EVIL PROJECT CONTEXT');
  // What the runner writes from `placeSkills`: the one skill the platform granted.
  writeSkill(path.join(cwd, '.pi', 'skills'), 'good-skill');
}

describe('pi through the adapter: isolation', () => {
  it('loads the placed skill and nothing from ~/.pi, ~/.agents or project discovery', async () => {
    const home = path.join(g.root, 'hostile-home');
    const marker = path.join(g.root, 'hostile-extension-ran');
    const extension = `import { writeFileSync } from 'node:fs';\nexport default function () { writeFileSync(${JSON.stringify(marker)}, 'ran'); }\n`;
    writeHostileHome(home, extension);
    vi.stubEnv('HOME', home);
    const cwd = g.workspace();
    writeHostileWorkspace(cwd, extension);

    g.gateway.script([{ text: 'Hello.' }]);
    const request = g.baseRequest(cwd, {
      resources: {
        files: [],
        skills: [{ name: 'good-skill', files: [{ path: 'SKILL.md', contentBase64: '' }] }],
      },
    });
    await run({
      ...request,
      env: { ...request.env, HOME: home },
      portable: { ...request.portable, skills: { mode: 'allowlist', names: ['good-skill'] } },
    });

    const system = systemText(g.gateway.requests[0] as Recorded);
    expect(system).toContain('good-skill');
    for (const hostile of [
      'evil-home-skill',
      'evil-agents-skill',
      'evil-project-skill',
      'EVIL HOME CONTEXT',
      'EVIL PROJECT CONTEXT',
    ]) {
      expect(system).not.toContain(hostile);
    }
    expect(existsSync(marker)).toBe(false);
  });
});

describe('pi through the adapter: bash environment', () => {
  it("runs bash in the request's environment, not the runner's", async () => {
    vi.stubEnv('RUNNER_ONLY_SECRET', 'must-not-leak');
    const cwd = g.workspace();
    g.gateway.script([
      {
        call: {
          name: 'bash',
          args: { command: 'echo "secret=[$RUNNER_ONLY_SECRET] mark=[$PLATFORM_MARK]"' },
        },
      },
      { text: 'ok' },
    ]);
    const request = g.baseRequest(cwd);
    const frames = await run({ ...request, env: { ...request.env, PLATFORM_MARK: 'given' } });
    const output = frames.find((frame) => frame.frame === 'agent.tool.result');
    expect(output).toMatchObject({ status: 'completed' });
    expect(output?.frame === 'agent.tool.result' ? output.output : '').toContain(
      'secret=[] mark=[given]',
    );
  });
});
