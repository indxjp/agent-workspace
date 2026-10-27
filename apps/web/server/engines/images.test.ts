/**
 * ENG-07 (#306, ADR-0073 D2/D5/D7): the control plane's `engine → image` map.
 *
 * The parser itself is `packages/runtime`'s and is tested there; this suite holds what the control
 * plane adds on top of it: the catalogue it checks keys against is `ENGINE_IDS`, a malformed map
 * throws at start-up with a message that names keys and no value, `installed` on
 * `GET /api/engines` is the map, and a development process with nothing configured still offers
 * the Claude engine while a production one offers nothing it was not given.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { EngineImageConfigurationError } from '@agent-workspace/runtime/engine-images';

import { listEngines } from './handlers';
import {
  DEVELOPMENT_ENGINE_IMAGES,
  clearEngineImagesConfiguredForTests,
  configureEngineImagesForTests,
  engineIsInstalled,
  engineNotInstalledMessage,
  readConfiguredEngineImages,
} from './images';
import {
  clearEnginesRegisteredForTests,
  registerEngineForTests,
  registeredEngine,
  registeredEngines,
} from './registry';

const SECRET_IMAGE = `registry.internal.example/acme-private-project/runtime@sha256:${'e'.repeat(64)}`;

afterEach(() => {
  clearEngineImagesConfiguredForTests();
  clearEnginesRegisteredForTests();
});

describe('readConfiguredEngineImages', () => {
  it('reads the per-engine variable, and the pre-ENG-07 RUNTIME_IMAGE as the Claude entry', () => {
    expect([
      ...readConfiguredEngineImages({
        NODE_ENV: 'production',
        AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: SECRET_IMAGE,
      }),
    ]).toEqual([['claude-agent-sdk', SECRET_IMAGE]]);
    expect([
      ...readConfiguredEngineImages({ NODE_ENV: 'production', RUNTIME_IMAGE: SECRET_IMAGE }),
    ]).toEqual([['claude-agent-sdk', SECRET_IMAGE]]);
  });

  it('fails start-up on a malformed value and names the key, never the value', () => {
    const malformed = 'registry.internal.example/acme private project';
    let caught: unknown;
    try {
      readConfiguredEngineImages({
        NODE_ENV: 'production',
        AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: malformed,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineImageConfigurationError);
    const message = (caught as Error).message;
    expect(message).toContain('claude-agent-sdk');
    expect(message).not.toContain('registry.internal.example');
    expect(message).not.toContain('acme');
  });

  it('admits a mutable tag in production: the runner manager owns the digest gate', () => {
    // ADR-0073 D5: the control plane never starts a container, so it checks the reference's shape
    // and reports the engine installed; `engineImagesFor` refuses the same value in production.
    const tag = 'registry.internal.example/acme/runtime:latest';
    const images = readConfiguredEngineImages({
      NODE_ENV: 'production',
      AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: tag,
    });
    expect([...images]).toEqual([['claude-agent-sdk', tag]]);
    configureEngineImagesForTests(images);
    expect(engineIsInstalled('claude-agent-sdk')).toBe(true);
  });

  it('starts from the root compose.yaml web environment under the NODE_ENV its image sets', () => {
    // The regression #328's review found: the `web` service sets no NODE_ENV of its own and
    // inherits `production` from the Dockerfile's `web` target, while its engine image defaults to
    // the locally built `agent-workspace/runtime:dev` tag.
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const dockerfile = readFileSync(`${root}Dockerfile`, 'utf8');
    const webTarget = /^FROM\s+\S+\s+AS\s+web\s*$([\s\S]*?)(?=^FROM\s)/imu.exec(dockerfile)?.[1];
    const nodeEnv = /^ENV\s+NODE_ENV=(\S+)/mu.exec(webTarget ?? '')?.[1];
    expect(nodeEnv).toBe('production');

    const compose = readFileSync(`${root}compose.yaml`, 'utf8');
    const web = /^ {2}web:\s*$([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\s*$)/mu.exec(compose)?.[1] ?? '';
    expect(web).toMatch(/target: web/u);
    expect(web).not.toMatch(/^\s+NODE_ENV:/mu);
    const reference =
      /^\s+AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: \$\{RUNTIME_IMAGE:-([^}]+)\}$/mu.exec(
        web,
      )?.[1];
    expect(reference).toBe('agent-workspace/runtime:dev');

    const images = readConfiguredEngineImages({
      NODE_ENV: nodeEnv,
      AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: reference,
    });
    expect([...images]).toEqual([['claude-agent-sdk', 'agent-workspace/runtime:dev']]);
  });

  it('assumes the development image only outside production and only when nothing is set', () => {
    expect(readConfiguredEngineImages({ NODE_ENV: 'development' })).toBe(DEVELOPMENT_ENGINE_IMAGES);
    expect(readConfiguredEngineImages({ NODE_ENV: 'production' }).size).toBe(0);
  });

  it('follows the deployment posture: a local-posture production build keeps the default', () => {
    expect(
      readConfiguredEngineImages({
        NODE_ENV: 'production',
        AW_DEPLOYMENT_POSTURE: 'local',
        HOST: '127.0.0.1',
      }),
    ).toBe(DEVELOPMENT_ENGINE_IMAGES);
    expect(
      readConfiguredEngineImages({ NODE_ENV: 'production', AW_DEPLOYMENT_POSTURE: 'production' })
        .size,
    ).toBe(0);
    expect(
      readConfiguredEngineImages({ NODE_ENV: 'development', AW_DEPLOYMENT_POSTURE: 'production' })
        .size,
    ).toBe(0);
  });

  it('refuses an invalid posture rather than ignoring it', () => {
    expect(() =>
      readConfiguredEngineImages({ NODE_ENV: 'production', AW_DEPLOYMENT_POSTURE: 'prod' }),
    ).toThrow(/AW_DEPLOYMENT_POSTURE/u);
  });
});

describe('installed is the configured map', () => {
  it('reports an engine installed exactly when the map has an image for it', () => {
    // `acp` is not published by the contracts yet, so the catalogue route would refuse to serve it
    // (engine_catalogue_invalid); the registry's own projection is where its `installed` is read.
    const claude = registeredEngine('claude-agent-sdk');
    if (claude === null) throw new Error('claude-agent-sdk is not registered');
    registerEngineForTests({
      id: 'acp',
      displayName: 'acp',
      version: '0.0.0',
      capabilities: claude.capabilities,
    });

    configureEngineImagesForTests(new Map([['claude-agent-sdk', SECRET_IMAGE]]));
    expect(
      Object.fromEntries(registeredEngines().map((engine) => [engine.id, engine.installed])),
    ).toEqual({
      'claude-agent-sdk': true,
      'openai-agents': false,
      pi: false,
      mastra: false,
      acp: false,
    });
    expect(engineIsInstalled('acp')).toBe(false);

    clearEnginesRegisteredForTests();
    const served = listEngines();
    expect(served.status).toBe(200);
    expect(served.body).toMatchObject({
      engines: [
        { id: 'claude-agent-sdk', installed: true },
        { id: 'openai-agents', installed: false },
        { id: 'pi', installed: false },
        { id: 'mastra', installed: false },
      ],
    });

    configureEngineImagesForTests(new Map([['mastra', SECRET_IMAGE]]));
    expect(engineIsInstalled('mastra')).toBe(true);

    configureEngineImagesForTests(new Map());
    expect(listEngines().body).toMatchObject({
      engines: [
        { id: 'claude-agent-sdk', installed: false },
        { id: 'openai-agents', installed: false },
        { id: 'pi', installed: false },
        { id: 'mastra', installed: false },
      ],
    });
  });

  it('explains a refusal by engine, never by image', () => {
    configureEngineImagesForTests(new Map([['claude-agent-sdk', SECRET_IMAGE]]));
    const message = engineNotInstalledMessage('acp');
    expect(message).toContain('acp');
    expect(message).toContain('claude-agent-sdk');
    expect(message).not.toContain('registry.internal.example');
  });
});
