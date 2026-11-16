import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseEnvironment } from '../deployment.js';
import { runDeployCommand } from './command.js';
import {
  captured,
  capturedFailure,
  runtimeImageKey,
  stubRunner,
  toolHostTemplate,
} from './deploy.test-support.js';
import {
  setEnv,
  variablesByProject,
  vcrImage,
  vercelEnvironment,
  vercelProject,
  vercelResponder,
} from './deploy.vercel.test-support.js';

function variablesPerProjectCase(): void {
  it('gives each project only the variables it needs, and the master key to the gateway and the control plane alone', async () => {
    const target = await vercelProject();
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const byProject = variablesByProject(calls);
    const names = (project: string) => [...(byProject.get(project)?.keys() ?? [])].sort();
    expect(names('acme-ai-gateway')).toEqual(
      [
        'DATABASE_URL',
        'GATEWAY_CONTROL_PLANE_ORIGIN',
        'GATEWAY_PRICING_JSON',
        'GATEWAY_TOKEN_SECRET',
        'MASTER_ENCRYPTION_KEY',
        'MASTER_KEY_PROVIDER',
      ].sort(),
    );
    expect(byProject.get('acme-ai-gateway')?.get('GATEWAY_CONTROL_PLANE_ORIGIN')).toBe(
      'https://acme-ai.vercel.app',
    );
    expect(names('acme-ai-manager')).toEqual(
      [
        'AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK',
        'AW_VERCEL_TEAM_ID',
        'GATEWAY_PUBLIC_URL',
        'RUNNER_MANAGER_STATELESS',
        'RUNNER_MANAGER_TOKEN',
        'RUNTIME_DRIVER',
      ].sort(),
    );
    const manager = byProject.get('acme-ai-manager');
    expect(manager?.get('RUNNER_MANAGER_STATELESS')).toBe('true');
    expect(manager?.get('GATEWAY_PUBLIC_URL')).toBe('https://acme-ai-gateway.vercel.app');
    expect(manager?.get('AW_VERCEL_TEAM_ID')).toBe('team_acme');
    expect(manager?.get('RUNNER_MANAGER_TOKEN')).toBe(env['RUNNER_MANAGER_TOKEN']);
    const controlPlane = byProject.get('acme-ai');
    expect(controlPlane?.get('MODEL_GATEWAY_URL')).toBe('https://acme-ai-gateway.vercel.app');
    expect(controlPlane?.get('RUNNER_MANAGER_URL')).toBe('https://acme-ai-manager.vercel.app');
    expect(controlPlane?.has('MASTER_ENCRYPTION_KEY')).toBe(true);
    // The engine catalogue: without it no engine is installed and setup's runtime test sends none.
    expect(controlPlane?.has('AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK')).toBe(true);
    for (const name of ['WEB_IMAGE', 'GATEWAY_IMAGE', 'RUNNER_IMAGE', 'E2B_RUNTIME_TEMPLATE']) {
      expect(controlPlane?.has(name), name).toBe(false);
    }
    for (const name of ['MASTER_ENCRYPTION_KEY', 'SESSION_SECRET', 'DATABASE_URL']) {
      expect(manager?.has(name), name).toBe(false);
    }
    expect(byProject.get('acme-ai-gateway')?.has('SESSION_SECRET')).toBe(false);
    for (const variables of byProject.values()) {
      for (const name of variables.keys()) expect(name).not.toMatch(/E2B_API_KEY|VERCEL_TOKEN/u);
    }
  });
}

function publicUrlAndPolicyCases(): void {
  it('gives the AW_PUBLIC_URL that aw deploy writes to the control plane alone (#955)', async () => {
    const target = await vercelProject();
    await setEnv(target, 'AW_PUBLIC_URL', 'https://agents.acme.example');
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const added = calls.filter(
      ({ args }) => args[0] === 'env' && args[1] === 'add' && args[2] === 'AW_PUBLIC_URL',
    );
    expect(added.map(({ args, env, input }) => [args[3], env['VERCEL_PROJECT_ID'], input])).toEqual(
      [['production', 'acme-ai', 'https://agents.acme.example']],
    );
  });

  it('gives the vercel-sandbox control plane the deployment policy as JSON, not as the quoted .env line', async () => {
    const target = await vercelProject();
    const policy = '{"promotion":{"minEvalScore":1}}';
    const file = path.join(target, '.env');
    // What `aw deploy` writes: single-quoted, for Compose.
    await writeFile(file, `${await readFile(file, 'utf8')}AW_DEPLOYMENT_POLICY='${policy}'\n`);
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const byProject = variablesByProject(calls);
    const controlPlane = byProject.get('acme-ai');
    // apps/web parses this at start-up and refuses to start on a value that is not JSON.
    expect(controlPlane?.get('AW_DEPLOYMENT_POLICY')).toBe(policy);
    expect(controlPlane?.get('RUNTIME_DRIVER')).toBe('vercel-sandbox');
    expect(controlPlane?.has('AW_VERCEL_TEAM_ID')).toBe(false);
    expect(byProject.get('acme-ai-manager')?.has('AW_DEPLOYMENT_POLICY')).toBe(false);
    expect(byProject.get('acme-ai-manager')?.get('AW_VERCEL_TEAM_ID')).toBe('team_acme');
  });
}

function runtimeImageCases(): void {
  it('runs the vercel-sandbox manager on its Container Registry image and keeps the control plane on the catalogue image', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const byProject = variablesByProject(calls);
    const manager = byProject.get('acme-ai-manager');
    const controlPlane = byProject.get('acme-ai');
    expect(manager?.get(runtimeImageKey)).toBe(vcrImage);
    expect(controlPlane?.get(runtimeImageKey)).not.toBe(vcrImage);
    expect(controlPlane?.has(runtimeImageKey)).toBe(true);
    for (const variables of byProject.values()) {
      expect(variables.has('VERCEL_SANDBOX_RUNTIME_IMAGE')).toBe(false);
    }
  });

  it.each([
    ['is not set', ''],
    ['is an image from another registry', `ghcr.io/acme/runtime@sha256:${'a'.repeat(64)}`],
    ['names another project', `acme/other-manager/runtime@sha256:${'a'.repeat(64)}`],
    ['is not pinned by digest', 'acme/acme-ai-manager/runtime:latest'],
  ])(
    'refuses a vercel-sandbox deploy whose registry image %s, before any tool runs',
    async (_name, value) => {
      const target = await vercelProject();
      await setEnv(target, 'VERCEL_SANDBOX_RUNTIME_IMAGE', value);
      const { runner, calls } = stubRunner(vercelResponder(false));

      const { message } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
      );

      expect(message).toContain(
        'VERCEL_SANDBOX_RUNTIME_IMAGE must be <team-slug>/acme-ai-manager/',
      );
      expect(message).toContain('Nothing was run');
      if (value !== '') expect(message).not.toContain(value);
      expect(calls).toEqual([]);
    },
  );
}

function runtimeDriverCase(): void {
  it('gives the Vercel control plane a writable runtime verification file, and keeps one .env sets', async () => {
    for (const driver of ['vercel-sandbox', 'external'] as const) {
      const target = await vercelProject();
      if (driver === 'external') {
        const profile = path.join(target, 'agent-workspace.yaml');
        const text = await readFile(profile, 'utf8');
        await writeFile(profile, text.replace('default: vercel-sandbox', 'default: external'));
        await setEnv(
          target,
          'E2B_RUNTIME_TEMPLATE',
          'acme-runtime:123e4567-e89b-42d3-a456-426614174000',
        );
      }
      const { runner, calls } = stubRunner(vercelResponder(false));

      await captured(() =>
        runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
      );

      const byProject = variablesByProject(calls);
      expect(byProject.get('acme-ai')?.get('RUNTIME_DRIVER'), driver).toBe(driver);
      expect(byProject.get('acme-ai')?.get('AW_RUNTIME_VERIFICATION_FILE'), driver).toBe(
        '/tmp/agent-workspace/runtime-verifications.json',
      );
      for (const project of ['acme-ai-manager', 'acme-ai-gateway']) {
        expect(byProject.get(project)?.has('AW_RUNTIME_VERIFICATION_FILE'), project).toBe(false);
      }
    }

    const target = await vercelProject();
    await setEnv(target, 'AW_RUNTIME_VERIFICATION_FILE', '/tmp/custom/verifications.json');
    const { runner, calls } = stubRunner(vercelResponder(false));
    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );
    expect(variablesByProject(calls).get('acme-ai')?.get('AW_RUNTIME_VERIFICATION_FILE')).toBe(
      '/tmp/custom/verifications.json',
    );
  });
}

function runtimeProfileCase(): void {
  it('deploys the runtime the profile selects, not the driver .env was created with', async () => {
    const target = await vercelProject();
    const profile = path.join(target, 'agent-workspace.yaml');
    const text = await readFile(profile, 'utf8');
    expect(text).toContain('default: vercel-sandbox');
    await writeFile(profile, text.replace('default: vercel-sandbox', 'default: external'));
    const refused = stubRunner(vercelResponder(false));

    // The runtime image `.env` holds is an OCI digest; the production manager exits 1 on it.
    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner: refused.runner,
        environment: vercelEnvironment,
      }),
    );
    expect(message).toContain('E2B_RUNTIME_TEMPLATE must be an E2B');
    expect(refused.calls).toEqual([]);

    const envFile = path.join(target, '.env');
    await writeFile(
      envFile,
      `${await readFile(envFile, 'utf8')}E2B_RUNTIME_TEMPLATE=acme-runtime:123e4567-e89b-42d3-a456-426614174000\n`,
    );
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const manager = variablesByProject(calls).get('acme-ai-manager');
    expect(manager?.get('RUNTIME_DRIVER')).toBe('external');
    expect(manager?.get('EXTERNAL_PROVIDER')).toBe('e2b');
    expect(manager?.get('AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK')).toBe(
      'acme-runtime:123e4567-e89b-42d3-a456-426614174000',
    );
    expect(manager?.has('E2B_RUNTIME_TEMPLATE')).toBe(false);
    expect(manager?.has('AW_VERCEL_TEAM_ID')).toBe(false);
  });
}

function toolHostCase(): void {
  it('renders the tool-host flag to the manager and control plane for an external runtime only (#827)', async () => {
    const target = await vercelProject();
    const envFile = path.join(target, '.env');
    await writeFile(
      envFile,
      `${await readFile(envFile, 'utf8')}E2B_TOOL_HOST_TEMPLATE=${toolHostTemplate}\n`,
    );
    const sandbox = stubRunner(vercelResponder(false));
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: sandbox.runner,
        environment: vercelEnvironment,
      }),
    );
    for (const project of ['acme-ai-manager', 'acme-ai']) {
      const variables = variablesByProject(sandbox.calls).get(project);
      expect(variables?.has('AGENT_WORKSPACE_TOOL_HOST_IMAGE'), project).toBe(false);
      expect(variables?.has('E2B_TOOL_HOST_TEMPLATE'), project).toBe(false);
    }
    // Without a tool host the gateway has no use for the manager token (ADR-0132).
    expect(
      variablesByProject(sandbox.calls).get('acme-ai-gateway')?.has('RUNNER_MANAGER_TOKEN'),
    ).toBe(false);

    const profile = path.join(target, 'agent-workspace.yaml');
    await writeFile(
      profile,
      (await readFile(profile, 'utf8')).replace('default: vercel-sandbox', 'default: external'),
    );
    await writeFile(
      envFile,
      `${await readFile(envFile, 'utf8')}E2B_RUNTIME_TEMPLATE=acme-runtime:123e4567-e89b-42d3-a456-426614174000\n`,
    );
    const external = stubRunner(vercelResponder(false));
    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner: external.runner,
        environment: vercelEnvironment,
      }),
    );
    for (const project of ['acme-ai-manager', 'acme-ai']) {
      const variables = variablesByProject(external.calls).get(project);
      expect(variables?.get('AGENT_WORKSPACE_TOOL_HOST_IMAGE'), project).toBe(toolHostTemplate);
      expect(variables?.has('E2B_TOOL_HOST_TEMPLATE'), project).toBe(false);
    }
    // The manager's tool sandbox route requires the manager token, so the gateway holds it.
    const byProject = variablesByProject(external.calls);
    expect(byProject.get('acme-ai-gateway')?.get('RUNNER_MANAGER_TOKEN')).toBe(
      byProject.get('acme-ai-manager')?.get('RUNNER_MANAGER_TOKEN'),
    );
    expect(byProject.get('acme-ai-gateway')?.has('AGENT_WORKSPACE_TOOL_HOST_IMAGE')).toBe(false);
  });
}

function addressCases(): void {
  it('uses the addresses in .env over the production URLs of the projects', async () => {
    const target = await vercelProject();
    const file = path.join(target, '.env');
    const text = await readFile(file, 'utf8');
    await writeFile(
      file,
      text
        .replace('\nMODEL_GATEWAY_URL=\n', '\nMODEL_GATEWAY_URL=https://gateway.acme.example/\n')
        .replace('\nRUNNER_MANAGER_URL=\n', '\nRUNNER_MANAGER_URL=https://manager.acme.example\n'),
    );
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const byProject = variablesByProject(calls);
    expect(byProject.get('acme-ai')?.get('MODEL_GATEWAY_URL')).toBe('https://gateway.acme.example');
    expect(byProject.get('acme-ai')?.get('RUNNER_MANAGER_URL')).toBe(
      'https://manager.acme.example',
    );
    expect(byProject.get('acme-ai-manager')?.get('GATEWAY_PUBLIC_URL')).toBe(
      'https://gateway.acme.example',
    );
  });

  it('refuses an address in .env that is not an https origin, by name, before any tool runs', async () => {
    const target = await vercelProject();
    const file = path.join(target, '.env');
    const text = await readFile(file, 'utf8');
    await writeFile(
      file,
      text.replace('\nMODEL_GATEWAY_URL=\n', '\nMODEL_GATEWAY_URL=http://gw.example/x\n'),
    );
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('MODEL_GATEWAY_URL is http://gw.example/x');
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });
}

describe('agent-workspace deploy to Vercel', () => {
  variablesPerProjectCase();
  publicUrlAndPolicyCases();
  runtimeImageCases();
  runtimeDriverCase();
  runtimeProfileCase();
  toolHostCase();
  addressCases();
});
