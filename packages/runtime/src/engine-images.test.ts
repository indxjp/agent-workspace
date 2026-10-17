/**
 * `engine-images.test.ts` — ENG-07's `engine → image` map (#306).
 *
 * Three properties, each of which the rest of the unit leans on:
 *
 * 1. **The catalogue is the map.** `engineImageInstalled` holds exactly when an image is
 *    configured, so `GET /api/engines`' `installed` and the run route's `engine_not_installed`
 *    cannot disagree about which engines a deployment offers.
 * 2. **A malformed map fails parsing, and the refusal names no value.** Asserted by feeding the
 *    parser a distinctive value and scanning the whole message for it, rather than by reading the
 *    message and agreeing with it.
 * 3. **The environment spelling is reversible.** A deployment configures engines by variable name,
 *    so two ids that collided on one name would be a silent mis-install.
 */
import { describe, expect, it } from 'vitest';

import {
  ENGINE_IMAGE_ENV_PREFIX,
  ENGINE_IMAGE_LABEL,
  ENGINE_IMAGE_VERSION_LABEL,
  EngineImageConfigurationError,
  LEGACY_RUNTIME_IMAGE_ENV,
  assertDigestPinnedEngineImages,
  engineImageEnvName,
  engineImageInstalled,
  parseEngineImageMap,
  readEngineImageMap,
  requireEngineImage,
  resolveEngineImage,
} from './engine-images.js';

const KNOWN = ['claude-agent-sdk', 'pi'] as const;
const CLAUDE = `registry.example/agent-workspace/runtime-claude-agent-sdk@sha256:${'a'.repeat(64)}`;
const PI = `registry.example/agent-workspace/runtime-pi@sha256:${'b'.repeat(64)}`;

describe('the engine image map', () => {
  it('parses a well-formed map and reports installation from it alone', () => {
    const images = parseEngineImageMap(
      [
        ['claude-agent-sdk', CLAUDE],
        ['pi', PI],
      ],
      { knownEngineIds: KNOWN },
    );
    expect([...images]).toEqual([
      ['claude-agent-sdk', CLAUDE],
      ['pi', PI],
    ]);
    expect(engineImageInstalled(images, 'claude-agent-sdk')).toBe(true);
    expect(engineImageInstalled(images, 'pi')).toBe(true);
    expect(engineImageInstalled(images, 'openai-agents')).toBe(false);
  });

  it('accepts a registry host carrying an explicit port', () => {
    const portedImage = `localhost:5000/agent-workspace/runtime@sha256:${'a'.repeat(64)}`;
    const images = parseEngineImageMap([['claude-agent-sdk', portedImage]], {
      knownEngineIds: KNOWN,
    });
    expect(images.get('claude-agent-sdk')).toBe(portedImage);
  });

  it('resolves the image of the run’s engine and refuses one it has no image for', () => {
    const images = parseEngineImageMap([['claude-agent-sdk', CLAUDE]], { knownEngineIds: KNOWN });
    expect(resolveEngineImage(images, 'claude-agent-sdk')).toEqual({ ok: true, image: CLAUDE });

    const refused = resolveEngineImage(images, 'pi');
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.code).toBe('engine_not_installed');
    // The sentence has to be actionable: which engine, which engines are installed, what to set.
    expect(refused.reason).toContain('"pi"');
    expect(refused.reason).toContain('claude-agent-sdk');
    expect(refused.reason).toContain('AGENT_WORKSPACE_RUNTIME_IMAGE_PI');
    // …and it must not leak the images that *are* configured.
    expect(refused.reason).not.toContain(CLAUDE);
  });

  it('throws the refusal from requireEngineImage, named by the asking driver', () => {
    const images = parseEngineImageMap([['claude-agent-sdk', CLAUDE]], { knownEngineIds: KNOWN });
    expect(requireEngineImage(images, 'claude-agent-sdk', 'docker')).toBe(CLAUDE);
    expect(() => requireEngineImage(images, 'pi', 'docker')).toThrow(
      /docker runtime: this deployment configures no runtime image for engine "pi"/u,
    );
  });

  it('refuses a map naming an engine this deployment does not publish', () => {
    expect(() => parseEngineImageMap([['pie', CLAUDE]], { knownEngineIds: KNOWN })).toThrow(
      EngineImageConfigurationError,
    );
    try {
      parseEngineImageMap([['pie', CLAUDE]], { knownEngineIds: KNOWN });
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(EngineImageConfigurationError);
      expect((error as EngineImageConfigurationError).keys).toEqual(['pie']);
    }
  });

  it('refuses a malformed value and names the key but never the value', () => {
    // A value distinctive enough that a substring scan of the whole message is decisive.
    const leak = 'registry.internal.example:5000/secret project/runtime:zzzQUARANTINEzzz';
    let caught: unknown;
    try {
      parseEngineImageMap([['pi', leak]], { knownEngineIds: KNOWN, source: 'environment' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineImageConfigurationError);
    const message = (caught as Error).message;
    expect(message).toContain('"pi"');
    expect(message).not.toContain('zzzQUARANTINEzzz');
    expect(message).not.toContain('registry.internal.example');
    expect(message).not.toContain('secret project');
  });

  it('refuses an unpinned image when the deployment requires digests, and a duplicate key', () => {
    expect(() =>
      parseEngineImageMap([['pi', 'agent-workspace/runtime-pi:latest']], {
        knownEngineIds: KNOWN,
        requireDigest: true,
      }),
    ).toThrow(/not pinned by sha256 digest/u);
    expect(() =>
      parseEngineImageMap(
        [
          ['pi', PI],
          ['pi', PI],
        ],
        { knownEngineIds: KNOWN },
      ),
    ).toThrow(/configured more than once/u);
  });

  it('reports every problem in one refusal rather than the first', () => {
    let error: EngineImageConfigurationError | null = null;
    try {
      parseEngineImageMap(
        [
          ['pie', CLAUDE],
          ['pi', 'not a reference'],
        ],
        { knownEngineIds: KNOWN },
      );
    } catch (thrown) {
      error = thrown as EngineImageConfigurationError;
    }
    expect(error?.keys).toEqual(['pie', 'pi']);
  });

  it('refuses a mutable tag at driver construction when digests are required', () => {
    expect(() =>
      assertDigestPinnedEngineImages(
        new Map([
          ['claude-agent-sdk', CLAUDE],
          ['pi', 'agent-workspace/runtime-pi:latest'],
        ]),
        'docker',
      ),
    ).toThrow(/docker runtime: production images must be pinned by sha256 digest; "pi" are not\./u);
    expect(() =>
      assertDigestPinnedEngineImages(new Map([['claude-agent-sdk', CLAUDE]]), 'docker'),
    ).not.toThrow();
  });
});

describe('the environment spelling of one engine’s image', () => {
  it('is the prefix plus the id, upper-cased with hyphens as underscores', () => {
    expect(engineImageEnvName('claude-agent-sdk')).toBe(
      `${ENGINE_IMAGE_ENV_PREFIX}CLAUDE_AGENT_SDK`,
    );
    expect(engineImageEnvName('pi')).toBe(`${ENGINE_IMAGE_ENV_PREFIX}PI`);
  });

  it('is injective over the id shapes this platform admits', () => {
    const ids = ['claude-agent-sdk', 'pi', 'openai-agents', 'p', 'a-b', 'ab'];
    expect(new Set(ids.map(engineImageEnvName)).size).toBe(ids.length);
  });

  it('refuses an id it cannot spell rather than inventing one', () => {
    for (const id of ['acp:codex', 'Claude', 'claude_agent_sdk', '', '1st']) {
      expect(() => engineImageEnvName(id)).toThrow(EngineImageConfigurationError);
    }
  });

  it('reads only the published engines, and keeps RUNTIME_IMAGE working for claude-agent-sdk', () => {
    const legacyOnly = readEngineImageMap(
      { [LEGACY_RUNTIME_IMAGE_ENV]: CLAUDE, AGENT_WORKSPACE_RUNTIME_IMAGE_FICTION: 'nonsense' },
      { knownEngineIds: KNOWN },
    );
    expect([...legacyOnly]).toEqual([['claude-agent-sdk', CLAUDE]]);

    // The per-engine variable wins over the legacy one when both are set.
    const both = readEngineImageMap(
      { [LEGACY_RUNTIME_IMAGE_ENV]: PI, AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: CLAUDE },
      { knownEngineIds: KNOWN },
    );
    expect(both.get('claude-agent-sdk')).toBe(CLAUDE);

    // `RUNTIME_IMAGE` is never a second engine's default.
    expect(
      readEngineImageMap({ [LEGACY_RUNTIME_IMAGE_ENV]: CLAUDE }, { knownEngineIds: KNOWN }).has(
        'pi',
      ),
    ).toBe(false);
    expect([...readEngineImageMap({}, { knownEngineIds: KNOWN })]).toEqual([]);
  });

  it('still refuses a published engine whose own variable holds nonsense', () => {
    expect(() =>
      readEngineImageMap(
        { AGENT_WORKSPACE_RUNTIME_IMAGE_PI: 'two words' },
        { knownEngineIds: KNOWN },
      ),
    ).toThrow(EngineImageConfigurationError);
  });
});

describe('the image labels', () => {
  it('are the OCI names ADR-0073 fixes, and runtime.Dockerfile writes exactly them', async () => {
    expect(ENGINE_IMAGE_LABEL).toBe('io.agent-workspace.engine');
    expect(ENGINE_IMAGE_VERSION_LABEL).toBe('io.agent-workspace.engine-version');

    // A restatement across a file boundary is watched by a replay, not by a comment (ADR W2-CP-07).
    const { readFile } = await import('node:fs/promises');
    const dockerfile = await readFile(
      new URL('../../../runtime.Dockerfile', import.meta.url),
      'utf8',
    );
    expect(dockerfile).toContain(`${ENGINE_IMAGE_LABEL}=`);
    expect(dockerfile).toContain(`${ENGINE_IMAGE_VERSION_LABEL}=`);
  });
});
