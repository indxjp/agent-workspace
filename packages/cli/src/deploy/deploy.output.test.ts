import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runDeployCommand } from './command.js';
import {
  captured,
  capturedFailure,
  composeResponder,
  environment,
  helmResponder,
  infra,
  project,
  secretsOf,
  stubRunner,
  terraformResponder,
} from './deploy.test-support.js';
import { compareComposeServices, parseContainers, parseServiceHashes } from './compose.js';
import { hasDiffPlugin, summarizeManifests } from './helm.js';

function secretsNeverPrinted(): void {
  it.each([
    ['local', composeResponder, []],
    ['aws', helmResponder, []],
    ['gcp', terraformResponder, []],
  ] as const)(
    'never prints a .env or profile secret a %s tool echoes',
    async (cloud, responder, extra) => {
      const target = await project(cloud);
      if (cloud === 'gcp') {
        await writeFile(
          path.join(target, 'agent-workspace.yaml'),
          (await readFile(path.join(target, 'agent-workspace.yaml'), 'utf8')).replace(
            /relational: .*/u,
            'relational: postgres://ops:profile-pass-77@db.example:5432/aw',
          ),
        );
      }
      const secrets = [
        ...(await secretsOf(target)),
        ...(cloud === 'gcp' ? ['profile-pass-77'] : []),
      ];
      const echo = `${secrets.join(' ')} postgres://ops:profile-pass-77@db.example:5432/aw`;
      const { runner } = stubRunner(responder(true, echo));
      const infraArguments = cloud === 'local' ? [] : ['--infra', await infra()];

      const { output } = await captured(() =>
        runDeployCommand([target, '--yes', ...infraArguments, ...extra], { runner, environment }),
      );

      expect(output).toContain('***');
      for (const secret of secrets) expect(output).not.toContain(secret);
    },
  );
}

function redactedOutput(): void {
  it("passes render's own output through the redactor", async () => {
    const target = await project('gcp');
    // An operator key whose value happens to appear in what `render` prints.
    await writeFile(
      path.join(target, '.env'),
      `${await readFile(path.join(target, '.env'), 'utf8')}MY_API_TOKEN=helm/values\n`,
    );
    const infraDirectory = await infra();
    const { runner } = stubRunner(terraformResponder(false));

    const { output } = await captured(() =>
      runDeployCommand([target, '--infra', infraDirectory], { runner, environment }),
    );

    expect(output).toContain('unchanged  deploy/***.yaml');
    expect(output).not.toContain('helm/values');
  });

  it('masks secrets in the output of a failing tool and its refusal', async () => {
    const target = await project('local');
    const secrets = await secretsOf(target);
    const { runner } = stubRunner(() => ({
      status: 1,
      stdout: secrets.join(' '),
      stderr: secrets.join(' '),
    }));

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target], { runner, environment }),
    );

    for (const secret of secrets) {
      expect(output).not.toContain(secret);
      expect(message).not.toContain(secret);
    }
  });
}

describe('agent-workspace deploy output', () => {
  secretsNeverPrinted();
  redactedOutput();
});

describe('the Compose plan', () => {
  it('reads config hashes and containers', () => {
    expect([...parseServiceHashes('web abc\r\ngateway def\n\n')]).toEqual([
      ['web', 'abc'],
      ['gateway', 'def'],
    ]);
    expect(parseContainers('web\tabc\trunning\ngateway\tdef\texited\n')).toEqual([
      { service: 'web', configHash: 'abc', running: true },
      { service: 'gateway', configHash: 'def', running: false },
    ]);
  });

  it('tells create, recreate, start and unchanged apart', () => {
    const desired = new Map([
      ['web', 'h1'],
      ['gateway', 'h2'],
      ['runner', 'h3'],
      ['postgres', 'h4'],
    ]);
    expect(
      compareComposeServices(desired, [
        { service: 'gateway', configHash: 'old', running: true },
        { service: 'runner', configHash: 'h3', running: false },
        { service: 'postgres', configHash: 'h4', running: true },
      ]),
    ).toEqual([
      ['web', 'create'],
      ['gateway', 'recreate'],
      ['runner', 'start'],
      ['postgres', 'unchanged'],
    ]);
  });
});

describe('the Helm plan', () => {
  it('finds the diff plugin by name only', () => {
    expect(hasDiffPlugin('NAME\tVERSION\tDESCRIPTION\ndiff\t3.9.0\tPreview\n')).toBe(true);
    expect(hasDiffPlugin('NAME\tVERSION\tDESCRIPTION\nsecrets\t4.0\tdiff of secrets\n')).toBe(
      false,
    );
    expect(hasDiffPlugin('diff\n')).toBe(false);
  });

  it('summarises rendered manifests as Kind/name, skipping empty documents', () => {
    expect(
      summarizeManifests(
        '---\nkind: Deployment\nmetadata:\n  name: web\n---\n# empty\n---\nkind: Service\nmetadata:\n  name: gateway\n',
      ),
    ).toEqual(['Deployment/web', 'Service/gateway']);
  });
});
