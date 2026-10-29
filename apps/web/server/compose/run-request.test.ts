import { createHash } from 'node:crypto';
/**
 * The composer's own tests.
 *
 * Every assertion about the shape of the body is made against `RunRequest` — the schema
 * `apps/runner` parses the request with — rather than against a transcription of what it is
 * believed to want. That is the whole point: the defect this file exists because of was a body
 * that had never been checked against the contract it was posted to.
 */
import { log as webLogger } from '../telemetry/logger';
import { RunRequest } from '@agent-workspace/run-protocol';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
// ENG-04 (#303): the compile step moved into the Claude adapter. A *test* may reach an engine
// adapter — `dependency-cruiser.config.mjs`'s `web-does-not-import-an-engine-adapter` rule
// excludes test files, the same way the browser-boundary rule already does — because the two
// assertions below are about what the composed request compiles to on the engine it named, and
// there is no way to make that assertion without the engine.
import { compileRunRequest } from '@agent-workspace/engine-claude-agent-sdk/testing';
import { toolSandboxRunToken } from '@agent-workspace/gateway/tokens';
import {
  AgentPolicySchema,
  claudeDeniedToolsFor,
  type AgentResourceAssignmentsInput,
} from '@indx-workspace/contracts/agents';
import { verifyIdentity } from '@indx-workspace/contracts/identity-assertion';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunAgent } from '../agent-versions/session-version';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { withStoredConnectorIds } from '../agents/policy';
import type { AgentPermissions, AgentPolicy } from '../../contracts/agents';
import type { AgentRecord } from '../agents/contract';
import { createInMemoryModelsStoreProvider } from '../models/memory-store';
import type { DeploymentDefaultModels } from '../models/deployment-default';
import type { DiscoverModelsResult, DiscoveredModel } from '../models/discovery';
import type { LaunchContext } from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import { publicRunFailure } from '../runs/failures';
import { DomainError } from '../errors';
import {
  clearEnginesRegisteredForTests,
  registerEngineForTests,
  registeredEngine,
} from '../engines/registry';
import { createRunTokenIssuer, type RunTokenIssuer } from '../gateway/issuer';
import {
  createAgentRunResourceLoader,
  type AgentRunResourceLoader,
  type AgentRunResourceSelection,
  type ProjectResourceReader,
} from './resource-loader';
import { PreparationStepError } from '../runs/failures';
import { modelResolutionRefusal } from './run-preflight';
import {
  applyFileGrantPolicy,
  assertToolNamesFit,
  buildRunRequestFor,
  DEFAULT_WORKSPACE_ROOT,
  NO_DEFAULT_CONNECTION_REASON,
  portableAgentConfigFor,
  readRuntimeSettings,
  resolveModelForRun,
  runNetworkGrant,
  sandboxFor,
  type ModelResolutionLayers,
  type ModelSelection,
  type RunToolSnapshot,
  type RuntimeSettings,
  withToolHostRunHeaders,
} from './run-request';

/** The SHA-256 of no bytes, built at runtime: a reference whose content is never read here. */
const EMPTY_SHA256 = createHash('sha256').digest('hex');

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const RUN = '11111111-1111-4111-8111-111111111111';
const SESSION = '44444444-4444-4444-8444-444444444444';
const USER = '66666666-6666-4666-8666-666666666666';
const MODEL_CONNECTION = '77777777-7777-4777-8777-777777777777';

const SETTINGS: RuntimeSettings = {
  runnerUrl: 'http://runner:8080',
  workspaceRoot: '/workspace',
};

/** The gateway's token signing secret (at least 32 bytes), from which the tool token derives. */
const SIGNING_SECRET = 's'.repeat(32);
let issued = 0;
const GATEWAY: RunTokenIssuer = {
  baseUrl: 'http://gateway:4000',
  issue() {
    issued += 1;
    return Promise.resolve(`run-token-${String(issued)}`);
  },
};

const ALL_ON: AgentPermissions = {
  readFiles: true,
  writeFiles: true,
  runCommands: true,
  unrestrictedNetwork: true,
};
const ALL_OFF: AgentPermissions = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

describe('readRuntimeSettings', () => {
  it('refuses a deployment with no RUNNER_URL, and names the variable', () => {
    const result = readRuntimeSettings({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('RUNNER_URL');
    // No default. The reason a missing runtime must not become a guessed one is in the function.
    expect(result.reason).toContain('503');
  });

  it('refuses a RUNNER_URL that is not an http(s) URL', () => {
    expect(readRuntimeSettings({ RUNNER_URL: 'runner:8080' }).ok).toBe(false);
    expect(readRuntimeSettings({ RUNNER_URL: 'ftp://runner:8080' }).ok).toBe(false);
    expect(readRuntimeSettings({ RUNNER_URL: '   ' }).ok).toBe(false);
  });

  it('accepts a URL, strips its trailing slash, and defaults the workspace root', () => {
    const result = readRuntimeSettings({ RUNNER_URL: 'http://runner:8080/' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.settings.runnerUrl).toBe('http://runner:8080');
    expect(result.settings.workspaceRoot).toBe(DEFAULT_WORKSPACE_ROOT);
  });

  it('takes RUNNER_WORKSPACE_ROOT when it is set', () => {
    const result = readRuntimeSettings({
      RUNNER_URL: 'https://runtime.internal',
      RUNNER_WORKSPACE_ROOT: '/srv/sandboxes/',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.settings.workspaceRoot).toBe('/srv/sandboxes');
  });
});

/**
 * The permission floor moved (ENG-04b, #325).
 *
 * `toolPolicyFor` was here and is now `packages/contracts`' `claudeBaseToolPolicyFor`, whose own
 * tests cover the four switches. What is still this file's business is everything *portable*; the
 * union of the floor with a stored arm is the Claude adapter's
 * (`packages/engine-claude-agent-sdk/src/tools.test.ts`).
 */

describe('sandboxFor', () => {
  it('gives each workspace and session its own cwd (spec §25)', () => {
    const a = sandboxFor(WORKSPACE, SESSION, SETTINGS);
    const b = sandboxFor(
      '33333333-3333-4333-8333-333333333333',
      '55555555-5555-4555-8555-555555555555',
      SETTINGS,
    );
    expect(a.cwd).toBe(`/workspace/${WORKSPACE}/${SESSION}`);
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.projectKey).not.toBe(b.projectKey);
  });

  it('names no engine configuration directory at all (ENG-04b, #325)', () => {
    // The `configDir` this used to return was `${cwd}/.claude` — one engine's layout, chosen by a
    // control plane that may not import an engine adapter. The adapter derives it now, so there is
    // nothing here to get wrong for a second engine.
    expect(Object.keys(sandboxFor(WORKSPACE, SESSION, SETTINGS)).toSorted()).toEqual([
      'cwd',
      'projectKey',
    ]);
  });

  it("produces a projectKey the SDK's own validator accepts", () => {
    // Checked through the schema, not against a copy of the regex: `RunProjectKey`'s superRefine is
    // what rejects a key the SDK would silently ignore (R-01 §7).
    const { projectKey } = sandboxFor(WORKSPACE, SESSION, SETTINGS);
    expect(() => RunRequest.pick({ projectKey: true }).parse({ projectKey })).not.toThrow();
  });
});

describe('portableAgentConfigFor', () => {
  const agent = {
    id: '55555555-5555-4555-8555-555555555555',
    workspaceId: WORKSPACE,
    name: 'General',
    instructions: 'Be brief.',
    modelConnectionId: null,
    model: null,
    runtimeProfileId: null,
    permissions: ALL_ON,
    policy: null,
    ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
    createdBy: '66666666-6666-4666-8666-666666666666',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  /** One loaded skill assignment, in the shape `AgentRunResourceLoader` produces. */
  function skillResource(name: string): {
    name: string;
    files: { path: string; size: number; sha256: string }[];
  } {
    return {
      name,
      files: [{ path: 'SKILL.md', size: 0, sha256: EMPTY_SHA256 }],
    };
  }

  it('grants no skill and no connector when no committed assignment was loaded', () => {
    const config = portableAgentConfigFor(agent);
    // `{ mode: 'all' }` would hand a run every skill directory on the image. See the function.
    expect(config.skills).toEqual({ mode: 'allowlist', names: [] });
    expect(config.mcpServers).toEqual({});
    expect(config.limits).toEqual({ maxTurns: null, maxBudgetUsd: null });
    expect(config.name).toBe('General');
    expect(config.instructions).toBe('Be brief.');
    expect(config.model).toBeNull();
  });

  it('appends project instructions without replacing the agent or granting permissions', () => {
    const config = portableAgentConfigFor(
      agent,
      { ...ALL_ON, runCommands: false },
      'Use Q3 sources.',
    );
    expect(config.instructions).toBe('Be brief.\n\nUse Q3 sources.');
    // The permission switch is the portable statement; which tools it removes is the engine's
    // business now (ENG-04b), and `packages/engine-claude-agent-sdk/src/tools.test.ts` asserts it.
    expect(config.permissions.runCommands).toBe(false);
  });

  it('carries no tool vocabulary at all, so a second engine cannot be handed Claude tool names', () => {
    expect('tools' in portableAgentConfigFor(agent)).toBe(false);
  });

  it('turns off the switches an openai-agents arm withholds, over an override too (ADR-0074 D12)', () => {
    const withholding = {
      ...agent,
      policy: {
        engine: 'openai-agents' as const,
        withheldPermissions: ['writeFiles', 'runCommands'] as const,
        skills: { mode: 'all' as const },
        limits: { maxTurns: null, maxBudgetUsd: null },
      },
    };
    expect(portableAgentConfigFor(withholding).permissions).toEqual({
      ...ALL_ON,
      writeFiles: false,
      runCommands: false,
    });
    expect(
      portableAgentConfigFor(withholding, { ...ALL_ON, readFiles: false }).permissions,
    ).toEqual({
      readFiles: false,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: true,
    });
  });

  // ── S-13: a stored policy is strictly narrowing ──────────────────────────────────────────
  describe('a stored policy (S-13)', () => {
    const narrowedAgent = {
      ...agent,
      permissions: { ...ALL_ON, runCommands: false },
      policy: {
        engine: 'claude-agent-sdk' as const,
        tools: {
          base: 'claude_code_preset' as const,
          // Tries to re-enable Bash, which `permissions.runCommands: false` denies.
          autoApprove: ['Bash'],
          deny: [],
          permissionMode: 'default' as const,
          allowDangerouslySkipPermissions: false,
        },
        skills: { mode: 'allowlist' as const, names: ['triage'] },
        limits: { maxTurns: 12, maxBudgetUsd: 4.5 },
      },
    };

    it('carries the stored limits through to the compiled config', () => {
      const config = portableAgentConfigFor(narrowedAgent);
      expect(config.limits).toEqual({ maxTurns: 12, maxBudgetUsd: 4.5 });
    });

    it('carries the stored skills allowlist through for a name that is still assigned', () => {
      const config = portableAgentConfigFor(narrowedAgent, undefined, null, {
        files: [],
        skills: [skillResource('triage')],
        mcpServers: {},
      });
      expect(config.skills).toEqual({ mode: 'allowlist', names: ['triage'] });
    });

    // Review finding (AC2): `skills` is the only lever bounding a run's skill surface, so the
    // assignments are its ceiling at compose time exactly as the permission booleans are for
    // `deny`. A stored policy that outlives an assignment must not re-grant it.
    it('compiles a stored mode: all against zero assignments as an empty allowlist, never all', () => {
      const config = portableAgentConfigFor({
        ...narrowedAgent,
        policy: { ...narrowedAgent.policy, skills: { mode: 'all' as const } },
      });
      expect(config.skills).toEqual({ mode: 'allowlist', names: [] });
    });

    it('compiles a stored mode: all as exactly the skills currently assigned', () => {
      const config = portableAgentConfigFor(
        { ...narrowedAgent, policy: { ...narrowedAgent.policy, skills: { mode: 'all' as const } } },
        undefined,
        null,
        { files: [], skills: [skillResource('triage')], mcpServers: {} },
      );
      expect(config.skills).toEqual({ mode: 'allowlist', names: ['triage'] });
    });

    it('drops an allowlisted skill whose assignment has since been revoked', () => {
      const config = portableAgentConfigFor(
        {
          ...narrowedAgent,
          policy: {
            ...narrowedAgent.policy,
            skills: { mode: 'allowlist' as const, names: ['triage', 'revoked'] },
          },
        },
        undefined,
        null,
        { files: [], skills: [skillResource('triage')], mcpServers: {} },
      );
      expect(config.skills).toEqual({ mode: 'allowlist', names: ['triage'] });
    });

    it('carries the assigned connectors through by record key, not as tool approvals', () => {
      const config = portableAgentConfigFor(narrowedAgent, undefined, null, {
        files: [],
        skills: [],
        mcpServers: { github: { type: 'http', url: 'https://mcp.example' } },
      });
      expect(Object.keys(config.mcpServers)).toEqual(['github']);
    });
  });
});

describe('withToolHostRunHeaders (ADR-0115)', () => {
  it('tells only the tool host connector which run and agent call it', () => {
    const servers = withToolHostRunHeaders(
      {
        files: [],
        skills: [],
        mcpServers: {
          host: { type: 'http', url: 'http://127.0.0.1:9/token/mcp', headers: { a: 'b' } },
          other: { type: 'http', url: 'https://mcp.example' },
        },
        connectorNames: { host: 'aw-dev-tools', other: 'github' },
      },
      'run-1',
      'サポート',
    );
    const host = servers['host'];
    // A header value is a ByteString: the Unicode name travels percent-encoded.
    expect(() => new Headers(host && 'headers' in host ? host.headers : {})).not.toThrow();
    expect(host).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:9/token/mcp',
      headers: { a: 'b', 'x-aw-run-id': 'run-1', 'x-aw-agent': encodeURIComponent('サポート') },
    });
    expect(servers['other']).toEqual({ type: 'http', url: 'https://mcp.example' });
  });
});

describe('applyFileGrantPolicy — the compose-side legacy guard (ENG-04b, #325)', () => {
  it('answers the read-only-grant denials, in the order the adapter also derives them', () => {
    expect(
      applyFileGrantPolicy('/workspace/w/s', [
        { kind: 'file', path: 'secret.txt', access: 'read', size: 0, sha256: EMPTY_SHA256 },
        { kind: 'directory', path: 'archive', access: 'read' },
        { kind: 'file', path: 'draft.txt', access: 'read-write', size: 0, sha256: EMPTY_SHA256 },
      ]),
    ).toEqual([
      'Edit(//workspace/w/s/secret.txt)',
      'Edit(//workspace/w/s/archive/**)',
      'Bash',
      'BashOutput',
      'KillShell',
    ]);
  });

  it('answers nothing when no grant is read-only, so a run without one is unnarrowed', () => {
    expect(applyFileGrantPolicy('/workspace/w/s', [])).toEqual([]);
    expect(
      applyFileGrantPolicy('/workspace/w/s', [
        { kind: 'file', path: 'draft.txt', access: 'read-write', size: 0, sha256: EMPTY_SHA256 },
      ]),
    ).toEqual([]);
  });
});

/** What a legacy session composes from: the stored row; the resource loaders here ignore assignments. */
async function rowRunAgent(
  agents: ReturnType<typeof createInMemoryAgentStoreProvider>,
  context: LaunchContext,
): Promise<RunAgent> {
  const agent = await agents.forWorkspace(context.principal.workspaceId).get(context.agent.id);
  if (agent === null) throw new Error(`agent ${context.agent.id} is not in the workspace`);
  return {
    agent,
    assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
    toolBundles: [],
    subagents: [],
  };
}

/** A launch context over a real in-memory run record, so nothing here is a hand-built shape. */
async function launchContext(): Promise<{
  context: LaunchContext;
  agents: ReturnType<typeof createInMemoryAgentStoreProvider>;
  agentId: string;
}> {
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'General',
      instructions: '',
      modelConnectionId: MODEL_CONNECTION,
      model: null,
      permissions: ALL_OFF,
    },
    {
      principalId: '77777777-7777-4777-8777-777777777777',
      userId: '66666666-6666-4666-8666-666666666666',
    },
  );
  if (created.kind !== 'created') throw new Error(created.kind);
  const runs = new InMemoryRunStore();
  const run = await runs.create({
    engine: 'claude-agent-sdk',
    id: RUN,
    workspaceId: WORKSPACE,
    agentId: created.agent.id,
    sessionId: SESSION,
  });
  return {
    agents,
    agentId: created.agent.id,
    context: {
      run,
      agent: { id: created.agent.id, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' },
      session: { id: SESSION, agentId: created.agent.id, engine: null },
      principal: {
        principalId: USER,
        ownerPrincipalId: USER,
        userId: USER,
        workspaceId: WORKSPACE,
        scope: null,
      },
      prompt: 'say pong',
    },
  };
}

describe("buildRunRequestFor's protocol check (ENG-04)", () => {
  afterEach(() => clearEnginesRegisteredForTests());

  it('refuses with a typed engine_model_protocol_unsupported whose sentence becomes the run failure', async () => {
    // Every provider answers `anthropic-messages`, so the built-in descriptor can never reach
    // the refusal. Replace it with one that speaks only the Responses dialect, which the gateway
    // does not serve for an `anthropic` connection.
    const builtIn = registeredEngine('claude-agent-sdk');
    if (builtIn === null) throw new Error('the built-in engine is not registered');
    // `installed` is the deployment's image map since ENG-07, not a field a descriptor carries.
    registerEngineForTests({
      id: builtIn.id,
      displayName: builtIn.displayName,
      version: builtIn.version,
      capabilities: { ...builtIn.capabilities, wireProtocols: ['openai-responses'] },
    });
    const { context, agents } = await launchContext();

    const refusal: unknown = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      undefined,
      null,
      undefined,
      undefined,
      null,
      'anthropic',
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(DomainError);
    const domain = refusal as DomainError;
    expect(domain.code).toBe('engine_model_protocol_unsupported');
    expect(domain.publicMessage).toMatch(/^engine_model_protocol_unsupported: /u);
    expect(domain.publicMessage).toContain("'anthropic' model connection");
    // What the launcher writes to the run record, through the same function it calls.
    expect(
      publicRunFailure(refusal, {
        operation: 'prepare-request',
        publicMessage: 'The run request could not be prepared.',
        log: () => undefined,
      }),
    ).toBe(domain.publicMessage);
  });

  it('composes normally when the engine speaks a dialect the gateway serves for the provider', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      undefined,
      null,
      undefined,
      undefined,
      null,
      'anthropic',
    );
    expect(request.engine).toBe('claude-agent-sdk');
  });
});

describe('buildRunRequestFor', () => {
  it('produces a body the §14.3 schema accepts', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
    );
    // The assertion is the runner's own parse, not a field-by-field comparison with a copy of it.
    expect(() => RunRequest.parse(request)).not.toThrow();
    expect(request.runId).toBe(RUN);
    expect(request.prompt).toBe('say pong');
    expect(request.cwd).toBe(`/workspace/${WORKSPACE}/${SESSION}`);
    expect(request.session).toEqual({ kind: 'fresh', sessionId: SESSION });
    expect(request.env['ANTHROPIC_BASE_URL']).toBe('http://gateway:4000');
    expect(request.env['ANTHROPIC_AUTH_TOKEN']).toMatch(/^run-token-/u);
    expect(request.env['NODE_USE_ENV_PROXY']).toBe('1');
    expect(JSON.stringify(request)).not.toContain('ANTHROPIC_API_KEY');
  });

  it('carries no key the strict schema would reject — in particular not agentId', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
    );
    expect(Object.keys(request).sort()).toEqual([
      'cwd',
      // ENG-04 (#303): the engine this run is addressed to, and the gateway connection handed to
      // its adapter programmatically rather than read out of `env`.
      'engine',
      'env',
      'gateway',
      // ENG-04b (#325): the private contract's v2 split. `agent` and `scope` are gone — the
      // portable core is what every engine must honour, `policy` is the arm only this run's engine
      // can read, and `projectKey` is the tenant namespace that used to travel inside `scope`
      // beside a `configDir` the engine now derives for itself.
      'policy',
      'portable',
      'projectKey',
      'prompt',
      'resources',
      'runId',
      'session',
      'sessionId',
    ]);
  });

  it('forwards the run’s outputSchema, and carries none when the run had none (ADR-0143)', async () => {
    const { context, agents } = await launchContext();
    const outputSchema = { type: 'object', properties: { verdict: { type: 'string' } } };
    const asked = await buildRunRequestFor(
      { ...context, outputSchema },
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
    );
    expect(RunRequest.parse(asked).outputSchema).toEqual(outputSchema);
    const plain = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
    );
    expect(plain).not.toHaveProperty('outputSchema');
  });

  it('composes the pinned configuration it is given, not the agent row (issue #612)', async () => {
    const { context, agents } = await launchContext();
    const row = await rowRunAgent(agents, context);
    const pinned = {
      ...row,
      agent: { ...row.agent, instructions: 'Version one.', permissions: ALL_ON },
    };
    const request = await buildRunRequestFor(context, pinned, SETTINGS, GATEWAY);
    expect(request.portable.instructions).toBe('Version one.');
    expect(request.portable.permissions).toEqual(ALL_ON);
    expect((await rowRunAgent(agents, context)).agent.permissions).toEqual(ALL_OFF);
  });

  it('composes no subagents key without subagents, and narrows each one to its parent’s permissions', async () => {
    const { context, agents } = await launchContext();
    const row = await rowRunAgent(agents, context);
    expect(
      'subagents' in (await buildRunRequestFor(context, row, SETTINGS, GATEWAY)).portable,
    ).toBe(false);

    const billing = {
      name: 'billing',
      description: 'Answers billing questions.',
      instructions: 'You answer billing questions.',
      model: null,
      permissions: ALL_ON,
      policy: null,
    };
    const parent = { ...row.agent, permissions: { ...ALL_ON, runCommands: false } };
    const request = await buildRunRequestFor(
      context,
      { ...row, agent: parent, subagents: [billing] },
      SETTINGS,
      GATEWAY,
    );

    expect(() => RunRequest.parse(request)).not.toThrow();
    expect(request.portable.subagents).toEqual([
      {
        name: 'billing',
        description: 'Answers billing questions.',
        instructions: 'You answer billing questions.',
        model: null,
        permissions: { ...ALL_ON, runCommands: false },
      },
    ]);
  });

  it('carries the agent’s permissions through to the SDK-facing policy', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
    );
    expect(request.portable.permissions).toEqual(ALL_OFF);
    // The tool names those switches remove are compiled by the engine, not by compose (ENG-04b).
    expect(compileRunRequest(request).disallowedTools).toContain('Bash');
  });

  it('compiles assigned enabled resources and makes read-only grants override write tools', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      ALL_ON,
      null,
      {
        load: () =>
          Promise.resolve({
            files: [
              {
                kind: 'file' as const,
                path: 'sources/readonly.txt',
                access: 'read' as const,
                size: 0,
                sha256: EMPTY_SHA256,
              },
            ],
            skills: [
              {
                name: 'assigned-skill',
                files: [
                  {
                    path: 'SKILL.md',
                    size: 0,
                    sha256: EMPTY_SHA256,
                  },
                ],
              },
            ],
            mcpServers: {
              assigned: { type: 'http' as const, url: 'https://mcp.example.test' },
            },
          }),
      },
    );

    expect(request.resources?.files.map((file) => file.path)).toEqual(['sources/readonly.txt']);
    expect(request.resources?.skills.map((skill) => skill.name)).toEqual(['assigned-skill']);
    expect(request.portable.skills).toEqual({ mode: 'allowlist', names: ['assigned-skill'] });
    expect(Object.keys(request.portable.mcpServers)).toEqual(['assigned']);
    const compiled = compileRunRequest(request);
    expect(compiled.skills).toEqual(['assigned-skill']);
    expect(Object.keys(compiled.mcpServers)).toEqual(['assigned']);
    expect(compiled.allowedTools).toContain('mcp__assigned__*');
    expect(compiled.disallowedTools).toContain(
      `Edit(//workspace/${WORKSPACE}/${SESSION}/sources/readonly.txt)`,
    );
    expect(compiled.disallowedTools).toContain('Bash');
  });

  describe('a fileScope narrows the agent’s file grants (issue #1539)', () => {
    const fileOf = (path: string) => ({
      kind: 'file' as const,
      path,
      access: 'read' as const,
      size: 0,
      sha256: EMPTY_SHA256,
    });
    const loader = {
      load: () =>
        Promise.resolve({
          files: [
            { kind: 'directory' as const, path: 'docs', access: 'read' as const },
            fileOf('docs/alice/a.md'),
            fileOf('docs/bob/b.md'),
          ],
          skills: [],
          mcpServers: {},
        }),
    };

    it('keeps only the files inside the scope in the request', async () => {
      const { context, agents } = await launchContext();
      const request = await buildRunRequestFor(
        { ...context, fileScope: ['docs/alice'] },
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
        ALL_ON,
        null,
        loader,
      );
      expect(request.resources?.files.map((file) => file.path)).toEqual(['docs/alice/a.md']);
      const compiled = compileRunRequest(request);
      expect(compiled.disallowedTools.join(' ')).not.toContain('docs/bob');
    });

    it('keeps every grant when the run has no scope', async () => {
      const { context, agents } = await launchContext();
      const request = await buildRunRequestFor(
        context,
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
        ALL_ON,
        null,
        loader,
      );
      expect(request.resources?.files).toHaveLength(3);
    });

    it('refuses a scope outside the grants before a token is issued', async () => {
      const { context, agents } = await launchContext();
      const before = issued;
      await expect(
        buildRunRequestFor(
          { ...context, fileScope: ['docs/alice', 'finance'] },
          await rowRunAgent(agents, context),
          SETTINGS,
          GATEWAY,
          {},
          ALL_ON,
          null,
          loader,
        ),
      ).rejects.toThrow(/^run_file_scope_not_granted: /u);
      expect(issued).toBe(before);
    });

    it('refuses any scope for an agent that has no files', async () => {
      const { context, agents } = await launchContext();
      await expect(
        buildRunRequestFor(
          { ...context, fileScope: ['docs/alice'] },
          await rowRunAgent(agents, context),
          SETTINGS,
          GATEWAY,
          {},
          ALL_ON,
          null,
          { load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }) },
        ),
      ).rejects.toThrow(/run_file_scope_not_granted/u);
    });

    // @story US-STO-06
    it('[US-STO-06][unit][run] a scope that narrows a grant over the run limit still composes', async () => {
      const { context, agents } = await launchContext();
      const over = {
        load: () =>
          Promise.resolve({
            files: [
              { kind: 'directory' as const, path: 'docs', access: 'read' as const },
              fileOf('docs/alice/a.md'),
              { ...fileOf('docs/bob/b.bin'), size: RUN_FILES_MAX_BYTES + 1 },
            ],
            skills: [],
            mcpServers: {},
          }),
      };
      const compose = async (fileScope?: readonly string[]) =>
        buildRunRequestFor(
          fileScope === undefined ? context : { ...context, fileScope },
          await rowRunAgent(agents, context),
          SETTINGS,
          GATEWAY,
          {},
          ALL_ON,
          null,
          over,
        );
      const scoped = await compose(['docs/alice']);
      expect(scoped.resources?.files.map((file) => file.path)).toEqual(['docs/alice/a.md']);
      // Unscoped, the same grant is over the limit: compose refuses it as the backstop.
      await expect(compose()).rejects.toMatchObject({ code: 'run_files_too_large' });
    });

    it('words a refusal the same whether a path is outside the grants or does not exist', async () => {
      const { context, agents } = await launchContext();
      const refusal = async (fileScope: readonly string[]): Promise<string> => {
        const failure: unknown = await buildRunRequestFor(
          { ...context, fileScope },
          await rowRunAgent(agents, context),
          SETTINGS,
          GATEWAY,
          {},
          ALL_ON,
          null,
          loader,
        ).catch((e: unknown) => e);
        return failure instanceof Error ? failure.message : 'resolved';
      };
      const outside = await refusal(['finance']);
      expect(outside).toMatch(/^run_file_scope_not_granted: /u);
      expect(outside).not.toContain('finance');
      expect(await refusal(['no-such-folder/x.md'])).toBe(outside);
    });
  });

  // @story US-STO-11
  it('[US-STO-11][unit][run] an attachment is a read reference in the body, never its bytes, and removes the shell (ADR-0146)', async () => {
    const { context, agents } = await launchContext();
    const brief = {
      kind: 'file' as const,
      path: 'notes/brief.md',
      access: 'read' as const,
      size: 5,
      sha256: createHash('sha256').update('brief').digest('hex'),
    };
    const loads: unknown[] = [];
    const request = await buildRunRequestFor(
      {
        ...context,
        attachments: [{ fileId: 'file-1', path: 'notes/brief.md', kind: 'file' }],
      },
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      ALL_ON,
      null,
      {
        load: (_workspaceId, assignments) => {
          loads.push(assignments.files);
          return Promise.resolve({
            files: assignments.files.length === 0 ? [] : [{ ...brief, access: 'read-write' }],
            skills: [],
            mcpServers: {},
          });
        },
      },
    );

    // The attachment's own load, by file id, read-only whatever the loader says.
    expect(loads).toContainEqual([{ fileId: 'file-1', access: 'read' }]);
    expect(request.resources?.files).toEqual([brief]);
    expect(request.portable.permissions.runCommands).toBe(false);
    const compiled = compileRunRequest(request);
    expect(compiled.disallowedTools).toContain(
      `Edit(//workspace/${WORKSPACE}/${SESSION}/notes/brief.md)`,
    );
    expect(compiled.disallowedTools).toContain('Bash');

    // ADR-0146 Decision 2: the grant is the run's. A follow-up turn without the attachment does
    // not name it, so the runner removes it like any revoked grant.
    const followUp = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      ALL_ON,
      null,
      { load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }) },
    );
    expect(followUp.resources?.files).toEqual([]);
  });

  it('passes the run’s assignments, the session’s project id and the agent’s own permissions to the resource loader (issue #125)', async () => {
    const { context, agents } = await launchContext();
    const runAgent = {
      ...(await rowRunAgent(agents, context)),
      assignments: { files: [], skillIds: ['a pinned skill'], connectorIds: [], storageGrants: [] },
    };
    const seen: {
      workspaceId: string | undefined;
      assignments: AgentResourceAssignmentsInput | undefined;
      projectId: string | null | undefined;
      permissions: AgentPermissions | undefined;
    } = {
      workspaceId: undefined,
      assignments: undefined,
      projectId: undefined,
      permissions: undefined,
    };
    await buildRunRequestFor(
      context,
      runAgent,
      SETTINGS,
      GATEWAY,
      {},
      ALL_ON,
      null,
      {
        load: (workspaceId, assignments, projectId, agentPermissions) => {
          seen.workspaceId = workspaceId;
          seen.assignments = assignments;
          seen.projectId = projectId;
          seen.permissions = agentPermissions;
          return Promise.resolve({ files: [], skills: [], mcpServers: {} });
        },
      },
      undefined,
      'a project id',
    );
    expect(seen).toEqual({
      workspaceId: WORKSPACE,
      assignments: runAgent.assignments,
      projectId: 'a project id',
      permissions: ALL_ON,
    });
  });

  it('threads no project id when the session has none, exactly like every pre-#125 call site', async () => {
    const { context, agents } = await launchContext();
    let seenProjectId: string | null | undefined = 'unset';
    await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      undefined,
      null,
      {
        load: (_workspaceId, _assignments, projectId) => {
          seenProjectId = projectId;
          return Promise.resolve({ files: [], skills: [], mcpServers: {} });
        },
      },
    );
    expect(seenProjectId).toBeNull();
  });

  // ── the project-resource ceiling honours an openai-agents arm's withheldPermissions ─────────
  // (the review's first minor on this PR): `buildRunRequestFor` used to hand `resourceLoader.load`
  // the raw `permissionOverride ?? agent.permissions`, so an arm that withholds a checkbox still
  // let a project's resource association through — exactly the widening ADR-0074 D12 forbids. The
  // real `createAgentRunResourceLoader` is used (not a stub) so these assert the actual ceiling
  // refusal in `resource-loader.ts`, not just that a narrowed value was threaded through.
  function noProjectResourceLoader(projectResources: ProjectResourceReader) {
    return createAgentRunResourceLoader({
      catalog: { forWorkspace: () => Promise.reject(new Error('unused')) },
      projectResources,
    });
  }

  it('refuses a project connector for an openai-agents arm that withholds unrestrictedNetwork, even though the checkbox is on', async () => {
    const { context, agents, agentId } = await launchContext();
    const policy: AgentPolicy = {
      engine: 'openai-agents',
      withheldPermissions: ['unrestrictedNetwork'],
      skills: { mode: 'all' },
      limits: { maxTurns: null, maxBudgetUsd: null },
    };
    await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, policy);
    const resourceLoader = noProjectResourceLoader({
      listFileIds: () => Promise.resolve([]),
      listMcpServerIds: () => Promise.resolve(['connector-shared']),
    });

    await expect(
      buildRunRequestFor(
        context,
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
        ALL_ON, // the checkbox floor: unrestrictedNetwork is on
        null,
        resourceLoader,
        undefined,
        'a project id',
      ),
    ).rejects.toThrow(/unrestrictedNetwork tool permission/u);
  });

  it('refuses a project file association for an openai-agents arm that withholds readFiles, even though the checkbox is on', async () => {
    const { context, agents, agentId } = await launchContext();
    const policy: AgentPolicy = {
      engine: 'openai-agents',
      withheldPermissions: ['readFiles'],
      skills: { mode: 'all' },
      limits: { maxTurns: null, maxBudgetUsd: null },
    };
    await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, policy);
    const resourceLoader = noProjectResourceLoader({
      listFileIds: () => Promise.resolve(['project-file']),
      listMcpServerIds: () => Promise.resolve([]),
    });

    await expect(
      buildRunRequestFor(
        context,
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
        ALL_ON, // the checkbox floor: readFiles is on
        null,
        resourceLoader,
        undefined,
        'a project id',
      ),
    ).rejects.toThrow(/readFiles tool permission/u);
  });

  const PORTABLE = { skills: { mode: 'all' }, limits: { maxTurns: null, maxBudgetUsd: null } };

  it.each([
    ['pi', { engine: 'pi', thinkingLevel: 'low', ...PORTABLE }, { thinkingLevel: 'low' }],
    ['pi without a setting', { engine: 'pi', ...PORTABLE }, {}],
    ['mastra', { engine: 'mastra', ...PORTABLE }, {}],
    [
      'openai-agents',
      { engine: 'openai-agents', reasoningEffort: 'high', parallelToolCalls: false, ...PORTABLE },
      { reasoningEffort: 'high', parallelToolCalls: false },
    ],
  ] as const)(
    'forwards the engine-native settings of a %s policy and nothing else',
    async (_name, policy, arm) => {
      const { context, agents, agentId } = await launchContext();
      await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, AgentPolicySchema.parse(policy));

      const request = await buildRunRequestFor(
        context,
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
      );

      expect(request.engine).toBe(policy.engine);
      expect(request.policy).toStrictEqual(arm);
    },
  );

  it('compiles the Claude arm from the stored tools, or from none', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
    );

    expect(request.engine).toBe('claude-agent-sdk');
    expect(request.policy).toStrictEqual({ tools: null, fileGrantDeny: [] });
  });

  it('puts the gate and the calls a decision admitted into the Claude arm (ADR-0145)', async () => {
    const { context, agents, agentId } = await launchContext();
    await agents.forWorkspace(WORKSPACE).replacePolicy(
      agentId,
      AgentPolicySchema.parse({
        engine: 'claude-agent-sdk',
        tools: {
          base: 'claude_code_preset',
          autoApprove: [],
          deny: [],
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
        },
        requireApproval: ['Bash'],
        skills: { mode: 'all' },
        limits: { maxTurns: null, maxBudgetUsd: null },
      }),
    );
    const decided = {
      ...context,
      run: {
        ...context.run,
        approvedToolCalls: [{ toolName: 'Bash', canonicalCall: 'Bash {"command":"ls"}' }],
      },
    };

    const request = await buildRunRequestFor(
      decided,
      await rowRunAgent(agents, decided),
      SETTINGS,
      GATEWAY,
      {},
    );

    expect(request.policy).toMatchObject({
      requireApproval: ['Bash'],
      approvedToolCalls: ['Bash {"command":"ls"}'],
    });
    const first = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
    );
    expect(first.policy).not.toHaveProperty('approvedToolCalls');
  });

  it('forwards the handoff opt-in only when the stored Claude arm has it (ADR-0145 D4)', async () => {
    const { context, agents, agentId } = await launchContext();
    const stored = (handoff: boolean) =>
      AgentPolicySchema.parse({
        engine: 'claude-agent-sdk',
        tools: {
          base: 'claude_code_preset',
          autoApprove: [],
          deny: [],
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
        },
        ...(handoff ? { handoff: true } : {}),
        skills: { mode: 'all' },
        limits: { maxTurns: null, maxBudgetUsd: null },
      });
    const policyOf = async () =>
      (await buildRunRequestFor(context, await rowRunAgent(agents, context), SETTINGS, GATEWAY, {}))
        .policy;

    await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, stored(true));
    expect(await policyOf()).toMatchObject({ handoff: true });
    await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, stored(false));
    expect(await policyOf()).not.toHaveProperty('handoff');
  });

  it('mints a fresh token for every serialization and closes the A.11 environment', async () => {
    const { context, agents } = await launchContext();
    const first = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {
        ASSIGNED_AGENT_SECRET: 'agent-only',
      },
    );
    const second = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {
        ASSIGNED_AGENT_SECRET: 'agent-only',
      },
    );
    expect(first.env['ANTHROPIC_AUTH_TOKEN']).not.toBe(second.env['ANTHROPIC_AUTH_TOKEN']);

    const compiled = compileRunRequest(first);
    const spec = await import('node:fs/promises').then(({ readFile }) =>
      readFile(new URL('../../../../docs/spec.md', import.meta.url), 'utf8'),
    );
    const section = spec.slice(
      spec.indexOf('## A.11 Environment contract'),
      spec.indexOf('## A.12 Driver conformance'),
    );
    const tableNames = [...section.matchAll(/^\| `([^`]+)`/gmu)].flatMap((match) =>
      (match[1] ?? '').split(' / '),
    );
    const conditional = new Set([
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'agent secrets',
    ]);
    const mandatory = tableNames.filter((name) => !conditional.has(name));
    expect(mandatory).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
      'AGENT_WORKSPACE_RUN_ID',
      'AGENT_WORKSPACE_SESSION_ID',
      'NODE_USE_ENV_PROXY',
    ]);
    for (const name of mandatory) expect(compiled.env[name]).toBeTruthy();
    expect(compiled.env['NODE_USE_ENV_PROXY']).toBe('1');
    expect(compiled.env['AW_SESSION_MIRROR_TOKEN']).toBe(compiled.env['ANTHROPIC_AUTH_TOKEN']);
    expect(Object.keys(compiled.env).sort()).toEqual(
      [
        ...mandatory,
        'AW_SESSION_MIRROR_TOKEN',
        'CLAUDE_CODE_PROJECT_DIR_NAME',
        'ENABLE_TOOL_SEARCH',
        'ASSIGNED_AGENT_SECRET',
      ].sort(),
    );
  });

  it('threads a resolved (connection, model) pair through to the composed request', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      undefined,
      null,
      undefined,
      { connectionId: '88888888-8888-4888-8888-888888888888', model: 'resolved-model' },
    );
    expect(request.portable.model).toBe('resolved-model');
  });
});

describe('buildRunRequestFor — tool connectors through the gateway (S2-02f, #531)', () => {
  const ORDERS_LOW = '00000000-0000-4000-8000-00000000000a';
  const ORDERS_HIGH = '00000000-0000-4000-8000-00000000000b';
  const WAREHOUSE = '00000000-0000-4000-8000-00000000000c';
  const OTHER_WAREHOUSE = '00000000-0000-4000-8000-00000000000e';
  const MCP_KEY = 'connector-00000000-0000-4000-8000-00000000000d';
  const MCP_ENTRY = {
    type: 'http' as const,
    url: 'https://mcp.example.test/mcp',
    headers: { 'X-Api-Key': 'mcp-connector-secret' },
  };

  function loaderWith(
    toolConnectors: AgentRunResourceSelection['toolConnectors'],
  ): AgentRunResourceLoader {
    return {
      load: () =>
        Promise.resolve({
          files: [],
          skills: [],
          mcpServers: { [MCP_KEY]: MCP_ENTRY },
          ...(toolConnectors === undefined ? {} : { toolConnectors }),
        }),
    };
  }

  /** `buildRunRequestFor` with a loader and a sink, everything else at its default. */
  async function compose(
    loader: AgentRunResourceLoader,
    snapshotTools: RunToolSnapshot | undefined,
    engine: AgentPolicy | null = null,
  ) {
    const { context, agents, agentId } = await launchContext();
    if (engine !== null) await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, engine);
    return buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      undefined,
      null,
      loader,
      undefined,
      null,
      undefined,
      snapshotTools,
    );
  }

  const orders = [
    { key: 'orders', name: 'orders', connectorId: ORDERS_LOW, operationNames: ['getOrder'] },
  ];
  const twoWarehouses = [
    {
      key: 'warehouse',
      name: 'warehouse',
      connectorId: WAREHOUSE,
      operationNames: ['list_tables', 'select'],
    },
    {
      key: 'warehouse_2',
      name: 'warehouse_2',
      connectorId: OTHER_WAREHOUSE,
      operationNames: ['list_tables', 'select'],
    },
  ];
  const openaiAgents: AgentPolicy = {
    engine: 'openai-agents',
    skills: { mode: 'all' },
    limits: { maxTurns: null, maxBudgetUsd: null },
  };
  const mastra: AgentPolicy = {
    engine: 'mastra',
    skills: { mode: 'all' },
    limits: { maxTurns: null, maxBudgetUsd: null },
  };

  it('seam check 1: an MCP connector entry is byte-identical with and without a tool connector', async () => {
    const before = await compose(loaderWith(undefined), undefined);
    const after = await compose(loaderWith(orders), () => Promise.resolve());
    expect(after.portable.mcpServers[MCP_KEY]).toEqual(before.portable.mcpServers[MCP_KEY]);
    expect(JSON.stringify(after.portable.mcpServers[MCP_KEY])).toBe(
      JSON.stringify(before.portable.mcpServers[MCP_KEY]),
    );
    // MCP entries keep their order; the tool entries follow.
    expect(Object.keys(after.portable.mcpServers)).toEqual([MCP_KEY, 'orders']);
  });

  it('hands an openapi connector over as an http server at the gateway holding only the run token', async () => {
    const request = await compose(loaderWith(orders), () => Promise.resolve());
    const token = request.env['ANTHROPIC_AUTH_TOKEN'];
    expect(request.portable.mcpServers['orders']).toEqual({
      type: 'http',
      url: `${GATEWAY.baseUrl}/v1/tools/${ORDERS_LOW}/mcp`,
      headers: { authorization: `Bearer ${String(token)}` },
    });
    expect(Object.keys(request.portable.mcpServers)).not.toContain(`connector-${ORDERS_LOW}`);
    // The loader handed compose no upstream URL or credential, so none can reach the request.
    const body = JSON.stringify(request);
    expect(body).not.toContain('orders.example.test');
    expect(body).not.toContain('upstream-secret');
  });

  describe('a write operation is implicitly requireApproval (ADR-0113 SD4)', () => {
    const quote = {
      key: 'erp',
      name: 'erp',
      connectorId: ORDERS_LOW,
      operationNames: ['getRate', 'createQuote'],
      approvalRules: ['mcp__erp__createQuote'],
    };
    const quotes = [quote];
    const claudeWithGate: AgentPolicy = {
      engine: 'claude-agent-sdk',
      tools: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: [],
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      },
      requireApproval: ['Bash', 'mcp__erp__createQuote'],
      skills: { mode: 'all' },
      limits: { maxTurns: null, maxBudgetUsd: null },
    };

    it('gives the Claude arm the connector write rule, carrying the run server key', async () => {
      const request = await compose(loaderWith(quotes), () => Promise.resolve());
      expect(request.policy).toMatchObject({ requireApproval: ['mcp__erp__createQuote'] });
      const suffixed = await compose(
        loaderWith([{ ...quote, key: 'erp_2', approvalRules: ['mcp__erp_2__createQuote'] }]),
        () => Promise.resolve(),
      );
      expect(suffixed.policy).toMatchObject({ requireApproval: ['mcp__erp_2__createQuote'] });
    });

    it('merges the stored rules with the connector rules, without a duplicate', async () => {
      const request = await compose(loaderWith(quotes), () => Promise.resolve(), claudeWithGate);
      expect(request.policy).toMatchObject({
        requireApproval: ['Bash', 'mcp__erp__createQuote'],
      });
    });

    it('leaves requireApproval out for a read-only connector', async () => {
      const request = await compose(loaderWith(orders), () => Promise.resolve());
      expect(request.policy).not.toHaveProperty('requireApproval');
    });

    it('sends a withholding engine no requireApproval; the gateway backstop refuses the write', async () => {
      const request = await compose(loaderWith(quotes), () => Promise.resolve(), openaiAgents);
      expect(request.policy).not.toHaveProperty('requireApproval');
    });
  });

  it('seam check 3: the tool url is on the gateway base the sandbox reaches, not the runner or web origin', async () => {
    const request = await compose(loaderWith(orders), () => Promise.resolve());
    const entry = request.portable.mcpServers['orders'];
    if (entry === undefined || !('url' in entry)) throw new Error('no http entry for orders');
    expect(new URL(entry.url).host).toBe(new URL(GATEWAY.baseUrl).host);
    expect(new URL(entry.url).host).toBe(request.env['ANTHROPIC_BASE_URL']?.replace('http://', ''));
    expect(new URL(entry.url).host).not.toBe(new URL(SETTINGS.runnerUrl).host);
  });

  it('keys orders and Orders as orders and orders_2, both parseable as RunRequest server names', async () => {
    const request = await compose(
      loaderWith([
        { key: 'orders', name: 'orders', connectorId: ORDERS_LOW, operationNames: ['getOrder'] },
        {
          key: 'orders_2',
          name: 'orders_2',
          connectorId: ORDERS_HIGH,
          operationNames: ['getOrder'],
        },
      ]),
      () => Promise.resolve(),
    );
    expect(Object.keys(request.portable.mcpServers)).toEqual([MCP_KEY, 'orders', 'orders_2']);
    expect(RunRequest.safeParse(request).success).toBe(true);
  });

  it('records the tool snapshot once with the sorted ids after the token is issued, before it resolves', async () => {
    const calls: { runId: string; ids: readonly string[]; issuedAt: number }[] = [];
    const request = await compose(
      loaderWith([
        { key: 'orders', name: 'orders', connectorId: ORDERS_LOW, operationNames: ['getOrder'] },
        {
          key: 'orders_2',
          name: 'orders_2',
          connectorId: ORDERS_HIGH,
          operationNames: ['getOrder'],
        },
      ]),
      (runId, ids) => {
        calls.push({ runId, ids, issuedAt: issued });
        return Promise.resolve();
      },
    );
    expect(calls).toEqual([{ runId: RUN, ids: [ORDERS_LOW, ORDERS_HIGH], issuedAt: issued }]);
    expect(request.env['ANTHROPIC_AUTH_TOKEN']).toBe(`run-token-${String(issued)}`);
  });

  it('fails closed with tool entries and no sink, and calls no sink without tool entries', async () => {
    await expect(compose(loaderWith(orders), undefined)).rejects.toThrow(
      /no tool snapshot is configured/u,
    );
    const sink = (): Promise<void> => Promise.reject(new Error('must not be called'));
    await expect(compose(loaderWith(undefined), sink)).resolves.toBeDefined();
    await expect(compose(loaderWith([]), sink)).resolves.toBeDefined();
  });

  it('does not resolve when the snapshot fails', async () => {
    await expect(
      compose(loaderWith(orders), () => Promise.reject(new Error('snapshot down'))),
    ).rejects.toThrow('snapshot down');
  });

  it('refuses two postgres connectors on openai-agents, whose tool names are unprefixed (C17)', async () => {
    const refusal: unknown = await compose(
      loaderWith(twoWarehouses),
      () => Promise.resolve(),
      openaiAgents,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(DomainError);
    expect(refusal).toMatchObject({
      code: 'connector_tool_name_collision',
      publicMessage: expect.stringMatching(/^connector_tool_name_collision: /u) as unknown,
    });
  });

  describe('an MCP connector keyed by its slug name (ADR-0113 SD13, #1109)', () => {
    const MCP_ID = '00000000-0000-4000-8000-00000000000d';
    const OTHER_MCP_ID = '00000000-0000-4000-8000-00000000000f';
    const legacy = (id: string, tool: string) => `mcp__connector-${id}__${tool}`;

    function slugLoader(): AgentRunResourceLoader {
      return {
        load: () =>
          Promise.resolve({
            files: [],
            skills: [],
            mcpServers: {
              'file-finder': MCP_ENTRY,
              [`connector-${OTHER_MCP_ID}`]: MCP_ENTRY,
            },
            connectorNames: { 'file-finder': 'file-finder', [`connector-${OTHER_MCP_ID}`]: 'Docs' },
            connectorKeys: { [MCP_ID]: 'file-finder', [OTHER_MCP_ID]: `connector-${OTHER_MCP_ID}` },
          }),
      };
    }

    function claudeRules(rules: {
      readonly base?: readonly string[];
      readonly autoApprove?: readonly string[];
      readonly deny?: readonly string[];
    }): AgentPolicy {
      return {
        engine: 'claude-agent-sdk',
        tools: {
          base: rules.base === undefined ? 'claude_code_preset' : [...rules.base],
          autoApprove: [...(rules.autoApprove ?? [])],
          deny: [...(rules.deny ?? [])],
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
        },
        skills: { mode: 'all' },
        limits: { maxTurns: null, maxBudgetUsd: null },
      };
    }

    it('hands the engine the slug as the server key and approves it as mcp__<slug>__*', async () => {
      const request = await compose(slugLoader(), undefined, claudeRules({}));
      expect(Object.keys(request.portable.mcpServers)).toEqual([
        'file-finder',
        `connector-${OTHER_MCP_ID}`,
      ]);
      expect(compileRunRequest(request).allowedTools).toEqual([
        `mcp__connector-${OTHER_MCP_ID}__*`,
        'mcp__file-finder__*',
      ]);
    });

    it('rewrites a stored rule written against connector-<id> to the run key, so a deny still matches', async () => {
      const request = await compose(
        slugLoader(),
        undefined,
        claudeRules({
          autoApprove: [legacy(MCP_ID, 'find_files')],
          deny: [legacy(MCP_ID, 'delete'), `${legacy(MCP_ID, 'write')}(/tmp/**)`],
        }),
      );
      const compiled = compileRunRequest(request);
      expect(compiled.allowedTools).toContain('mcp__file-finder__find_files');
      expect(compiled.disallowedTools).toEqual(
        expect.arrayContaining(['mcp__file-finder__delete', 'mcp__file-finder__write(/tmp/**)']),
      );
      expect(JSON.stringify(compiled)).not.toContain(`connector-${MCP_ID}`);
    });

    it('rewrites a connector-<id> rule in a tools.base list to the run key', async () => {
      const request = await compose(
        slugLoader(),
        undefined,
        claudeRules({ base: ['Read', legacy(MCP_ID, 'find_files')] }),
      );
      const compiled = compileRunRequest(request);
      expect(compiled.tools).toEqual(
        expect.arrayContaining(['Read', 'mcp__file-finder__find_files']),
      );
      expect(JSON.stringify(compiled)).not.toContain(`connector-${MCP_ID}`);
    });

    it('passes a rule already written with the slug, and a rule for a UUID-keyed connector, unchanged', async () => {
      const request = await compose(
        slugLoader(),
        undefined,
        claudeRules({
          autoApprove: ['mcp__file-finder__find_files'],
          deny: [legacy(OTHER_MCP_ID, 'delete')],
        }),
      );
      const compiled = compileRunRequest(request);
      expect(compiled.allowedTools).toContain('mcp__file-finder__find_files');
      expect(compiled.disallowedTools).toContain(legacy(OTHER_MCP_ID, 'delete'));
    });

    describe('a rule written against the slug is saved by id, so it follows the connector', () => {
      /** The rules as a save stores them while `MCP_ID` is named `file-finder`. */
      function savedRules(rules: Parameters<typeof claudeRules>[0]): AgentPolicy {
        return withStoredConnectorIds(claudeRules(rules), new Map([['file-finder', MCP_ID]]));
      }

      /** A run whose connectors are keyed `keys` (connector id to run key). */
      function keyedLoader(keys: Readonly<Record<string, string>>): AgentRunResourceLoader {
        const entries = Object.entries(keys);
        return {
          load: () =>
            Promise.resolve({
              files: [],
              skills: [],
              mcpServers: Object.fromEntries(entries.map(([, key]) => [key, MCP_ENTRY])),
              connectorNames: Object.fromEntries(entries.map(([, key]) => [key, key])),
              connectorKeys: { ...keys },
            }),
        };
      }

      it('keeps a slug-form deny matching after the connector is renamed', async () => {
        const request = await compose(
          keyedLoader({ [MCP_ID]: 'file-search' }),
          undefined,
          savedRules({ deny: ['mcp__file-finder__delete'] }),
        );
        const { disallowedTools } = compileRunRequest(request);
        expect(disallowedTools).toContain('mcp__file-search__delete');
        expect(disallowedTools).not.toContain('mcp__file-finder__delete');
      });

      it('keeps a slug-form deny matching when a same-named tool connector sends it to connector-<id>', async () => {
        const request = await compose(
          keyedLoader({ [MCP_ID]: `connector-${MCP_ID}` }),
          undefined,
          savedRules({ deny: ['mcp__file-finder__delete'] }),
        );
        expect(compileRunRequest(request).disallowedTools).toContain(legacy(MCP_ID, 'delete'));
      });

      it('does not hand a slug-form autoApprove to another connector renamed to that slug', async () => {
        const request = await compose(
          keyedLoader({ [MCP_ID]: 'file-search', [OTHER_MCP_ID]: 'file-finder' }),
          undefined,
          savedRules({ autoApprove: ['mcp__file-finder__find_files'] }),
        );
        const { allowedTools } = compileRunRequest(request);
        expect(allowedTools).toContain('mcp__file-search__find_files');
        expect(allowedTools).not.toContain('mcp__file-finder__find_files');
      });
    });

    it('leaves a rule for a connector that is not in the run as it is', async () => {
      const absent = '00000000-0000-4000-8000-0000000000ee';
      const request = await compose(
        slugLoader(),
        undefined,
        claudeRules({ deny: [legacy(absent, 'delete')] }),
      );
      expect(compileRunRequest(request).disallowedTools).toContain(legacy(absent, 'delete'));
    });
  });

  it('composes the same two connectors on claude-agent-sdk and mastra, which prefix the server key', async () => {
    await expect(
      compose(loaderWith(twoWarehouses), () => Promise.resolve()),
    ).resolves.toBeDefined();
    await expect(
      compose(loaderWith(twoWarehouses), () => Promise.resolve(), mastra),
    ).resolves.toBeDefined();
  });

  it('refuses a Mastra name collision across keys, and every name over 64 characters', async () => {
    // Mastra shows `a` + `b_select` and `a_b` + `select` both as `a_b_select`.
    await expect(
      compose(
        loaderWith([
          { key: 'a', name: 'a', connectorId: ORDERS_LOW, operationNames: ['b_select'] },
          { key: 'a_b', name: 'a_b', connectorId: ORDERS_HIGH, operationNames: ['select'] },
        ]),
        () => Promise.resolve(),
        mastra,
      ),
    ).rejects.toMatchObject({ code: 'connector_tool_name_collision' });
    expect(() =>
      assertToolNamesFit(
        [
          {
            key: 'k'.repeat(16),
            name: 'k',
            connectorId: ORDERS_LOW,
            operationNames: ['o'.repeat(42)],
          },
        ],
        'openai-agents',
      ),
    ).toThrow(/longer than 64 characters/u);
    expect(() =>
      assertToolNamesFit(
        [
          {
            key: 'k'.repeat(16),
            name: 'k',
            connectorId: ORDERS_LOW,
            operationNames: ['o'.repeat(41)],
          },
        ],
        'claude-agent-sdk',
      ),
    ).not.toThrow();
  });
});

describe('buildRunRequestFor meets the policy ceiling (S2-04c)', () => {
  const GITHUB_KEY = 'connector-00000000-0000-4000-8000-0000000000a1';
  const JIRA_KEY = 'connector-00000000-0000-4000-8000-0000000000a2';
  const ORDERS_ID = '00000000-0000-4000-8000-0000000000b1';
  const WAREHOUSE_ID = '00000000-0000-4000-8000-0000000000b2';
  const MCP_ENTRY = { type: 'http' as const, url: 'https://mcp.example.test/mcp' };

  function claudeArm(
    deny: readonly string[],
    limits: AgentPolicy['limits'] = { maxTurns: null, maxBudgetUsd: null },
  ): AgentPolicy {
    return {
      engine: 'claude-agent-sdk',
      tools: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: [...deny],
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      },
      skills: { mode: 'all' },
      limits,
    };
  }

  /** An agent saved with every switch on and `policy`, before the ceiling was lowered. */
  async function savedAgent(policy: AgentPolicy | null) {
    const launched = await launchContext();
    const store = launched.agents.forWorkspace(WORKSPACE);
    await store.update(launched.agentId, { permissions: ALL_ON });
    if (policy !== null) await store.replacePolicy(launched.agentId, policy);
    return launched;
  }

  /** A gateway that records each issue and always hands out the same token. */
  function recordingGateway(): RunTokenIssuer & { readonly issues: unknown[] } {
    const issues: unknown[] = [];
    return {
      baseUrl: 'http://gateway:4000',
      issues,
      issue(claims) {
        issues.push(claims);
        return Promise.resolve('run-token-fixed');
      },
    };
  }

  async function compose(
    policy: AgentPolicy | null,
    ceiling: ProjectPolicy | null,
    options: {
      readonly loader?: AgentRunResourceLoader;
      readonly snapshot?: RunToolSnapshot;
      readonly model?: ModelSelection;
      readonly gateway?: RunTokenIssuer;
      readonly limits?: NonNullable<LaunchContext['limits']>;
    } = {},
  ) {
    const { context, agents } = await savedAgent(policy);
    return buildRunRequestFor(
      options.limits === undefined ? context : { ...context, limits: options.limits },
      await rowRunAgent(agents, context),
      SETTINGS,
      options.gateway ?? GATEWAY,
      {},
      undefined,
      null,
      options.loader,
      options.model,
      null,
      undefined,
      options.snapshot,
      ceiling,
    );
  }

  async function refusalOf(promise: Promise<unknown>): Promise<DomainError> {
    const error: unknown = await promise.then(
      () => null,
      (reason: unknown) => reason,
    );
    if (!(error instanceof DomainError)) throw new Error('expected a DomainError refusal');
    return error;
  }

  it('caps runCommands, so the adapter denies Bash after the stored deny, which keeps its place', async () => {
    const request = await compose(claudeArm(['WebFetch']), {
      permissions: { runCommands: false },
    });
    expect(request.portable.permissions).toEqual({ ...ALL_ON, runCommands: false });
    expect(claudeDeniedToolsFor(request.portable.permissions)).toEqual([
      'Bash',
      'BashOutput',
      'KillShell',
    ]);
    // The adapter's own deny list: the stored arm first, then the met permission floor.
    expect(compileRunRequest(request).disallowedTools).toEqual([
      'WebFetch',
      'Bash',
      'BashOutput',
      'KillShell',
    ]);
  });

  it('composes a stored maxBudgetUsd of 5 as 2, a null one as 2, and maxTurns 50 as 10', async () => {
    const ceiling: ProjectPolicy = { limits: { maxTurns: 10, maxBudgetUsd: 2 } };
    const stored = await compose(claudeArm([], { maxTurns: 50, maxBudgetUsd: 5 }), ceiling);
    expect(stored.portable.limits).toEqual({ maxTurns: 10, maxBudgetUsd: 2 });
    const unset = await compose(claudeArm([], { maxTurns: null, maxBudgetUsd: null }), ceiling);
    expect(unset.portable.limits).toEqual({ maxTurns: 10, maxBudgetUsd: 2 });
    // An agent with no stored policy has null limits, and composes at the ceiling too.
    const compiled = await compose(null, ceiling);
    expect(compiled.portable.limits).toEqual({ maxTurns: 10, maxBudgetUsd: 2 });
  });

  it("a trial run's budget is the lower of the agent's policy and the trial budget, and a larger override cannot raise it", async () => {
    const policy = claudeArm([], { maxTurns: 20, maxBudgetUsd: 1 });
    const lowered = await compose(policy, null, { limits: { maxBudgetUsd: 0.3, maxTurns: 5 } });
    expect(lowered.portable.limits).toEqual({ maxTurns: 5, maxBudgetUsd: 0.3 });
    const larger = await compose(policy, null, { limits: { maxBudgetUsd: 5, maxTurns: 90 } });
    expect(larger.portable.limits).toEqual({ maxTurns: 20, maxBudgetUsd: 1 });
    const ceiling: ProjectPolicy = { limits: { maxTurns: 10, maxBudgetUsd: 0.5 } };
    const under = await compose(policy, ceiling, { limits: { maxBudgetUsd: 0.3 } });
    expect(under.portable.limits).toEqual({ maxTurns: 10, maxBudgetUsd: 0.3 });
    const over = await compose(policy, ceiling, { limits: { maxBudgetUsd: 0.9 } });
    expect(over.portable.limits).toEqual({ maxTurns: 10, maxBudgetUsd: 0.5 });
    const uncapped = await compose(null, null, { limits: { maxBudgetUsd: 0.3 } });
    expect(uncapped.portable.limits).toEqual({ maxTurns: null, maxBudgetUsd: 0.3 });
  });

  it('refuses a stored engine outside policy.engines before the loader or the gateway runs', async () => {
    const gateway = recordingGateway();
    let loads = 0;
    const refusal = await refusalOf(
      compose(
        {
          engine: 'openai-agents',
          skills: { mode: 'all' },
          limits: { maxTurns: null, maxBudgetUsd: null },
        },
        { engines: ['claude-agent-sdk'] },
        {
          gateway,
          loader: {
            load: () => {
              loads += 1;
              return Promise.resolve({ files: [], skills: [], mcpServers: {} });
            },
          },
        },
      ),
    );
    expect(refusal.code).toBe('policy_cannot_widen');
    expect(refusal.publicMessage).toMatch(/^policy_cannot_widen: /u);
    expect(refusal.publicMessage).toContain('engine:openai-agents');
    expect(gateway.issues).toEqual([]);
    expect(loads).toBe(0);
  });

  it('tags a resource load that throws, and a token issue that throws, with their steps (issue #827)', async () => {
    const stepOf = async (promise: Promise<unknown>): Promise<unknown> => {
      const error: unknown = await promise.then(
        () => null,
        (reason: unknown) => reason,
      );
      return error instanceof PreparationStepError ? error.step : error;
    };

    await expect(
      stepOf(
        compose(null, null, {
          loader: { load: () => Promise.reject(new Error('object store unavailable')) },
        }),
      ),
    ).resolves.toBe('resources');
    await expect(
      stepOf(
        compose(null, null, {
          gateway: {
            baseUrl: 'http://gateway:4000',
            issue: () => Promise.reject(new Error('token table unavailable')),
          },
        }),
      ),
    ).resolves.toBe('token');
  });

  it("refuses a resolved model outside policy.models, and the run's failure carries its code", async () => {
    const gateway = recordingGateway();
    const refusal = await refusalOf(
      compose(
        null,
        { models: ['claude-y'] },
        { gateway, model: { connectionId: MODEL_CONNECTION, model: 'claude-x' } },
      ),
    );
    expect(refusal.code).toBe('policy_cannot_widen');
    expect(refusal.publicMessage).toContain('model:claude-x');
    expect(gateway.issues).toEqual([]);
    expect(
      publicRunFailure(refusal, {
        operation: 'prepare-request',
        publicMessage: 'The run request could not be prepared.',
        log: () => undefined,
      }),
    ).toBe(refusal.publicMessage);
  });

  it('refuses a subagent model outside policy.models', async () => {
    const { context, agents } = await savedAgent(null);
    const row = await rowRunAgent(agents, context);
    const gateway = recordingGateway();
    const refusal = await refusalOf(
      buildRunRequestFor(
        context,
        {
          ...row,
          subagents: [
            {
              name: 'billing',
              description: 'Answers billing questions.',
              instructions: '',
              model: 'claude-x',
              permissions: ALL_OFF,
              policy: null,
            },
          ],
        },
        SETTINGS,
        gateway,
        {},
        undefined,
        null,
        undefined,
        { connectionId: MODEL_CONNECTION, model: 'claude-y' },
        null,
        undefined,
        undefined,
        { models: ['claude-y'] },
      ),
    );
    expect(refusal.code).toBe('policy_cannot_widen');
    expect(refusal.publicMessage).toContain('model:claude-x');
    expect(gateway.issues).toEqual([]);
  });

  it('drops an MCP connector, a W9 project one included, whose name is outside tools', async () => {
    const request = await compose(
      null,
      { tools: ['github'] },
      {
        loader: {
          load: () =>
            Promise.resolve({
              files: [],
              skills: [],
              mcpServers: { [GITHUB_KEY]: MCP_ENTRY, [JIRA_KEY]: MCP_ENTRY },
              connectorNames: { [GITHUB_KEY]: 'github', [JIRA_KEY]: 'jira' },
            }),
        },
      },
    );
    expect(Object.keys(request.portable.mcpServers)).toEqual([GITHUB_KEY]);
  });

  it('judges a slug-keyed MCP connector by its name under a tools ceiling (#1109)', async () => {
    const request = await compose(
      null,
      { tools: ['github'] },
      {
        loader: {
          load: () =>
            Promise.resolve({
              files: [],
              skills: [],
              mcpServers: { github: MCP_ENTRY, jira: MCP_ENTRY },
              connectorNames: { github: 'github', jira: 'jira' },
            }),
        },
      },
    );
    expect(Object.keys(request.portable.mcpServers)).toEqual(['github']);
  });

  it('drops an MCP entry the loader named no connector for under a tools ceiling (fails closed)', async () => {
    const request = await compose(
      null,
      { tools: ['github'] },
      {
        loader: {
          load: () =>
            Promise.resolve({ files: [], skills: [], mcpServers: { [GITHUB_KEY]: MCP_ENTRY } }),
        },
      },
    );
    expect(request.portable.mcpServers).toEqual({});
  });

  it('snapshots only the tool connectors the ceiling keeps, and composes no entry for the rest', async () => {
    const snapshots: (readonly string[])[] = [];
    const request = await compose(
      null,
      { tools: ['orders'] },
      {
        loader: {
          load: () =>
            Promise.resolve({
              files: [],
              skills: [],
              mcpServers: {},
              toolConnectors: [
                {
                  key: 'orders',
                  name: 'orders',
                  connectorId: ORDERS_ID,
                  operationNames: ['getOrder'],
                },
                {
                  key: 'warehouse',
                  name: 'warehouse',
                  connectorId: WAREHOUSE_ID,
                  operationNames: ['select'],
                },
              ],
            }),
        },
        snapshot: (_runId, ids) => {
          snapshots.push(ids);
          return Promise.resolve();
        },
      },
    );
    expect(snapshots).toEqual([[ORDERS_ID]]);
    expect(Object.keys(request.portable.mcpServers)).toEqual(['orders']);
  });

  it('regression: no ceiling composes exactly the request it composed before', async () => {
    const loader: AgentRunResourceLoader = {
      load: () =>
        Promise.resolve({
          files: [],
          skills: [],
          mcpServers: { [GITHUB_KEY]: MCP_ENTRY },
          connectorNames: { [GITHUB_KEY]: 'github' },
        }),
    };
    const { context, agents } = await savedAgent(
      claudeArm(['WebFetch'], { maxTurns: 50, maxBudgetUsd: 5 }),
    );
    const gateway = recordingGateway();
    const before = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      gateway,
      {},
      undefined,
      null,
      loader,
    );
    const after = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      gateway,
      {},
      undefined,
      null,
      loader,
      undefined,
      null,
      undefined,
      undefined,
      null,
    );
    expect(after).toEqual(before);
    expect(after.portable.limits).toEqual({ maxTurns: 50, maxBudgetUsd: 5 });
  });

  it('regression: the loader receives the met permissions, so a capped unrestrictedNetwork refuses a project connector with a typed ceiling error (#125)', async () => {
    const { context, agents } = await savedAgent(null);
    const loader = createAgentRunResourceLoader({
      catalog: { forWorkspace: () => Promise.reject(new Error('unused')) },
      projectResources: {
        listFileIds: () => Promise.resolve([]),
        listMcpServerIds: () => Promise.resolve(['connector-shared']),
      },
    });
    const refusal = await refusalOf(
      buildRunRequestFor(
        context,
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
        undefined,
        null,
        loader,
        undefined,
        'a project id',
        undefined,
        undefined,
        { permissions: { unrestrictedNetwork: false } },
      ),
    );
    expect(refusal.code).toBe('policy_cannot_widen');
    expect(refusal.publicMessage).toMatch(/^policy_cannot_widen: project a project id /u);
    expect(refusal.publicMessage).toContain(
      "this deployment's policy ceiling caps permissions.unrestrictedNetwork",
    );
    // The run's failure carries the sentence, not the generic launch message.
    expect(
      publicRunFailure(refusal, {
        operation: 'prepare-request',
        publicMessage: 'The run request could not be prepared.',
        log: () => undefined,
      }),
    ).toBe(refusal.publicMessage);
  });

  describe('runNetworkGrant (ADR-0117 decision 9, #785)', () => {
    const loaderOf = (
      mcpServers: AgentRunResourceSelection['mcpServers'],
    ): AgentRunResourceLoader => ({
      load: () =>
        Promise.resolve({
          files: [],
          skills: [],
          mcpServers,
          connectorNames: { [GITHUB_KEY]: 'github', [JIRA_KEY]: 'jira' },
        }),
    });
    const grantFor = async (
      loader: AgentRunResourceLoader | undefined,
      ceiling: ProjectPolicy | null,
    ) => {
      const { context, agents } = await savedAgent(null);
      return runNetworkGrant(context, await rowRunAgent(agents, context), loader, ceiling, null);
    };

    it('reports the switch and the DNS names of remote connectors, leaving out stdio and IPs', async () => {
      const grant = await grantFor(
        loaderOf({
          [GITHUB_KEY]: { type: 'http', url: 'https://mcp.example.test/mcp' },
          [JIRA_KEY]: { type: 'sse', url: 'http://10.0.0.5:8080/sse' },
          'connector-stdio': { type: 'stdio', command: 'mcp-server', args: [] },
          'connector-v6': { type: 'http', url: 'http://[::1]:9000/mcp' },
        }),
        null,
      );
      expect(grant).toEqual({
        unrestrictedNetwork: true,
        connectorHosts: ['mcp.example.test'],
      });
    });

    it('reports no switch when the ceiling turns it off', async () => {
      const grant = await grantFor(undefined, { permissions: { unrestrictedNetwork: false } });
      expect(grant).toEqual({ unrestrictedNetwork: false, connectorHosts: [] });
    });

    it('leaves out a connector the ceiling does not list', async () => {
      const grant = await grantFor(
        loaderOf({
          [GITHUB_KEY]: { type: 'http', url: 'https://github.example.test/mcp' },
          [JIRA_KEY]: { type: 'http', url: 'https://jira.example.test/mcp' },
        }),
        { tools: ['github'] },
      );
      expect(grant.connectorHosts).toEqual(['github.example.test']);
    });
  });
});

const CAPABILITIES = {
  streaming: true,
  toolUse: true,
  thinking: true,
  promptCaching: false,
  structuredOutput: true,
  contextManagement: true,
  webSearch: true,
  tokenCounting: false,
};

/** A `ModelDiscovery` fixture with a fixed, per-connection model list — no network, no cache. */
function fixedDiscovery(
  byConnectionId: Readonly<Record<string, readonly string[]>>,
): (resolved: { connection: { id: string } }) => Promise<DiscoverModelsResult> {
  return (resolved) => {
    const ids = byConnectionId[resolved.connection.id];
    if (ids === undefined) {
      return Promise.resolve({
        ok: false,
        reason: `no fixture models declared for connection ${resolved.connection.id}`,
        failure: { kind: 'unreachable' },
      });
    }
    const models: DiscoveredModel[] = ids.map((id) => ({
      connectionId: resolved.connection.id,
      providerModelId: id,
      displayName: id,
      capabilities: CAPABILITIES,
    }));
    return Promise.resolve({ ok: true, stale: false, models });
  };
}

describe('resolveModelForRun', () => {
  /** Four ready `anthropic` connections, one per layer, each with a distinct discovered model. */
  async function fourLayerFixture() {
    const provider = createInMemoryModelsStoreProvider([WORKSPACE]);
    const store = provider.forWorkspace(WORKSPACE);
    const layerNames = ['run', 'agent', 'project', 'workspace'] as const;
    const ids: Record<(typeof layerNames)[number], string> = {
      run: '',
      agent: '',
      project: '',
      workspace: '',
    };
    for (const layer of layerNames) {
      const created = await store.create({
        name: `${layer} connection`,
        provider: 'anthropic',
        apiKey: `sk-${layer}`,
        config: {},
      });
      if (created.kind !== 'created') throw new Error(`fixture setup failed: ${created.kind}`);
      ids[layer] = created.connection.id;
    }
    const layers: ModelResolutionLayers = {
      run: { connectionId: ids.run, model: 'run-model' },
      agent: { connectionId: ids.agent, model: 'agent-model' },
      project: { connectionId: ids.project, model: 'project-model' },
      workspace: { connectionId: ids.workspace, model: 'workspace-model' },
      deployment: null,
    };
    const discover = fixedDiscovery({
      [ids.run]: ['run-model'],
      [ids.agent]: ['agent-model'],
      [ids.project]: ['project-model'],
      [ids.workspace]: ['workspace-model'],
    });
    return { store, ids, layers, discover };
  }

  it('resolves the run override first when every layer is fully configured', async () => {
    const { store, ids, layers, discover } = await fourLayerFixture();
    await expect(resolveModelForRun(layers, store, discover)).resolves.toMatchObject({
      ok: true,
      layer: 'run',
      connectionId: ids.run,
      model: 'run-model',
      provider: 'anthropic',
      validated: true,
    });
  });

  it('walks down to the agent once the run layer is empty', async () => {
    const { store, ids, layers, discover } = await fourLayerFixture();
    await expect(
      resolveModelForRun({ ...layers, run: null }, store, discover),
    ).resolves.toMatchObject({ ok: true, layer: 'agent', connectionId: ids.agent });
  });

  it('walks down to the project once the run and agent layers are empty', async () => {
    const { store, ids, layers, discover } = await fourLayerFixture();
    await expect(
      resolveModelForRun({ ...layers, run: null, agent: null }, store, discover),
    ).resolves.toMatchObject({ ok: true, layer: 'project', connectionId: ids.project });
  });

  it('walks down to the workspace once only it is configured', async () => {
    const { store, ids, layers, discover } = await fourLayerFixture();
    await expect(
      resolveModelForRun({ ...layers, run: null, agent: null, project: null }, store, discover),
    ).resolves.toMatchObject({ ok: true, layer: 'workspace', connectionId: ids.workspace });
  });

  it('refuses, naming the workspace layer, when every layer is empty', async () => {
    const { store, discover } = await fourLayerFixture();
    const resolution = await resolveModelForRun(
      { run: null, agent: null, project: null, workspace: null, deployment: null },
      store,
      discover,
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.layer).toBe('workspace');
    expect(resolution.code).toBe('model_connection_unresolved');
    expect(resolution.reason).toContain('workspace default');
  });

  it('refuses at the run layer, WITHOUT falling through to the agent, when the run connection is not ready', async () => {
    const provider = createInMemoryModelsStoreProvider([WORKSPACE]);
    const store = provider.forWorkspace(WORKSPACE);
    // `openai-compatible` requires `config.baseUrl`; omitting it makes `ready` false even with a
    // credential — the same "missing required config" half of #126's derived readiness.
    const notReady = await store.create({
      name: 'Not ready',
      provider: 'openai-compatible',
      apiKey: 'sk-not-ready',
      config: {},
    });
    const ready = await store.create({
      name: 'Ready agent connection',
      provider: 'anthropic',
      apiKey: 'sk-agent',
      config: {},
    });
    if (notReady.kind !== 'created' || ready.kind !== 'created') {
      throw new Error('fixture setup failed');
    }
    const discover = fixedDiscovery({ [ready.connection.id]: ['agent-model'] });
    const resolution = await resolveModelForRun(
      {
        run: { connectionId: notReady.connection.id, model: 'whatever' },
        agent: { connectionId: ready.connection.id, model: 'agent-model' },
        project: null,
        workspace: null,
        deployment: null,
      },
      store,
      discover,
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.layer).toBe('run');
    expect(resolution.code).toBe('model_connection_unresolved');
    expect(resolution.reason).toMatch(/not ready/);
  });

  it('refuses, naming the layer, when the selected connection no longer exists', async () => {
    const { store, layers, discover } = await fourLayerFixture();
    const resolution = await resolveModelForRun(
      { ...layers, run: { connectionId: crypto.randomUUID(), model: 'ghost-model' } },
      store,
      discover,
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.layer).toBe('run');
    expect(resolution.reason).toContain('no longer exists');
  });

  it('refuses, naming the layer, when the model is not among what discovery currently returns', async () => {
    const { store, ids, layers, discover } = await fourLayerFixture();
    const resolution = await resolveModelForRun(
      { ...layers, run: { connectionId: ids.run, model: 'a-deprecated-model' } },
      store,
      discover,
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.layer).toBe('run');
    expect(resolution.code).toBe('model_unavailable');
    expect(resolution.reason).toContain('is not available');
  });

  // Issue #393: a model list that cannot be read is not evidence the model is gone. The explicit
  // selection proceeds, unvalidated, with a warning; the old behaviour refused every run whenever
  // the catalogue call failed, and the composer showed that as if the key were broken.
  it('proceeds with the explicit selection, and warns, when the model list cannot be read', async () => {
    const { store, ids, layers } = await fourLayerFixture();
    const warnings: string[] = [];
    const rateLimited = () =>
      Promise.resolve({
        ok: false as const,
        reason: 'Model list unavailable (provider returned HTTP 429).',
        failure: { kind: 'provider-error' as const, status: 429 },
      });
    const resolution = await resolveModelForRun(layers, store, rateLimited, (message) =>
      warnings.push(message),
    );
    expect(resolution).toMatchObject({
      ok: true,
      layer: 'run',
      connectionId: ids.run,
      validated: false,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('provider-error');
  });

  // PR #403 review: a discovery call that times out reads as `unreachable`, and the run proceeds.
  it('proceeds, unvalidated, when the model list call timed out (unreachable)', async () => {
    const { store, ids, layers } = await fourLayerFixture();
    const timedOut = () =>
      Promise.resolve({
        ok: false as const,
        reason: 'Model list unavailable (the provider could not be reached).',
        failure: { kind: 'unreachable' as const },
      });
    await expect(
      resolveModelForRun(layers, store, timedOut, () => undefined),
    ).resolves.toMatchObject({ ok: true, connectionId: ids.run, validated: false });
  });

  it('refuses with model_credential_rejected when the provider rejects the key', async () => {
    const { store, layers } = await fourLayerFixture();
    const rejected = () =>
      Promise.resolve({
        ok: false as const,
        reason: 'The provider rejected the API key (HTTP 401).',
        failure: { kind: 'credential-rejected' as const, status: 401 },
      });
    const resolution = await resolveModelForRun(layers, store, rejected);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.layer).toBe('run');
    expect(resolution.code).toBe('model_credential_rejected');
    expect(resolution.reason).toContain('HTTP 401');
  });

  // Issue #661: a refused connection or a failed lookup would fail the run the same way, after
  // minutes of retries, so it is refused before the run is queued.
  it('refuses with model_connection_failed when the provider cannot be connected to', async () => {
    const { store, layers } = await fourLayerFixture();
    const warnings: string[] = [];
    const refused = () =>
      Promise.resolve({
        ok: false as const,
        reason:
          "The provider could not be connected to (connection refused or DNS lookup failed). Check the connection's base URL and this host's network.",
        failure: { kind: 'connection-failed' as const },
      });
    const resolution = await resolveModelForRun(layers, store, refused, (message) =>
      warnings.push(message),
    );
    expect(resolution).toMatchObject({
      ok: false,
      layer: 'run',
      code: 'model_connection_failed',
    });
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.reason).toContain('could not be connected to');
    expect(modelResolutionRefusal(resolution).message).not.toContain('Choose a model');
    expect(warnings).toHaveLength(0);
  });
});

// Issue #506: the deployment default model, the ladder's last layer. A scaffolded agent writes
// `model: 'default'`, which `version-body.ts` stores as a connection with a null model; before
// this layer every such project was refused its first run with 422 model_connection_unresolved.
describe('resolveModelForRun — the deployment default layer (issue #506)', () => {
  const SONNET = 'claude-sonnet-4-5';

  /** The 'default' anthropic connection `aw dev` creates, and an agent naming it with no model. */
  async function connectionOnlyFixture() {
    const provider = createInMemoryModelsStoreProvider([WORKSPACE]);
    const store = provider.forWorkspace(WORKSPACE);
    const created = await store.create({
      name: 'default',
      provider: 'anthropic',
      apiKey: 'sk-default',
      config: {},
    });
    if (created.kind !== 'created') throw new Error(`fixture setup failed: ${created.kind}`);
    const connectionId = created.connection.id;
    const layersWith = (
      defaults: DeploymentDefaultModels,
      workspace: ModelSelection | null = null,
    ): ModelResolutionLayers => ({
      run: null,
      agent: null,
      project: null,
      workspace,
      deployment: { connectionId, defaults },
    });
    return { store, connectionId, layersWith };
  }

  it('resolves the agent connection plus the deployment default for its provider', async () => {
    const { store, connectionId, layersWith } = await connectionOnlyFixture();
    const discover = fixedDiscovery({ [connectionId]: [SONNET] });
    await expect(
      resolveModelForRun(layersWith({ anthropic: SONNET }), store, discover),
    ).resolves.toEqual({
      ok: true,
      layer: 'deployment',
      connectionId,
      model: SONNET,
      provider: 'anthropic',
      validated: true,
      connectionName: 'default',
    });
  });

  it('refuses at the deployment layer, before any provider call, when no default is configured for the provider', async () => {
    const { store, layersWith } = await connectionOnlyFixture();
    let discoveryCalls = 0;
    const discover = () => {
      discoveryCalls += 1;
      return Promise.resolve({ ok: true as const, stale: false, models: [] });
    };
    const resolution = await resolveModelForRun(layersWith({ openai: 'gpt-5.1' }), store, discover);
    expect(resolution).toEqual({
      ok: false,
      layer: 'deployment',
      code: 'model_connection_unresolved',
      reason:
        'the agent\'s model connection "default" names no model, no project or workspace default ' +
        'model is configured, and this deployment sets no default model for provider "anthropic".',
    });
    expect(discoveryCalls).toBe(0);
    await expect(resolveModelForRun(layersWith({}), store, discover)).resolves.toMatchObject({
      ok: false,
      layer: 'deployment',
      code: 'model_connection_unresolved',
    });
  });

  it('lets a workspace default win over the deployment default', async () => {
    const { store, connectionId, layersWith } = await connectionOnlyFixture();
    const discover = fixedDiscovery({ [connectionId]: [SONNET, 'workspace-model'] });
    await expect(
      resolveModelForRun(
        layersWith({ anthropic: SONNET }, { connectionId, model: 'workspace-model' }),
        store,
        discover,
      ),
    ).resolves.toMatchObject({ ok: true, layer: 'workspace', model: 'workspace-model' });
  });

  it('proceeds unvalidated with the configured id, and warns, when the model list cannot be read', async () => {
    const { store, connectionId, layersWith } = await connectionOnlyFixture();
    const warnings: string[] = [];
    const unreachable = () =>
      Promise.resolve({
        ok: false as const,
        reason: 'Model list unavailable (the provider could not be reached).',
        failure: { kind: 'unreachable' as const },
      });
    const resolution = await resolveModelForRun(
      layersWith({ anthropic: SONNET }),
      store,
      unreachable,
      (message) => warnings.push(message),
    );
    expect(resolution).toMatchObject({
      ok: true,
      layer: 'deployment',
      connectionId,
      model: SONNET,
      validated: false,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('deployment');
  });

  it('picks the newest dated release when discovery lists only dated ids', async () => {
    const { store, connectionId, layersWith } = await connectionOnlyFixture();
    const discover = fixedDiscovery({
      [connectionId]: [`${SONNET}-20250101`, `${SONNET}-20250929`, 'claude-opus-4-1-20250805'],
    });
    await expect(
      resolveModelForRun(layersWith({ anthropic: SONNET }), store, discover),
    ).resolves.toMatchObject({ ok: true, layer: 'deployment', model: `${SONNET}-20250929` });
  });

  it('refuses with model_unavailable at the deployment layer when the configured id is not offered', async () => {
    const { store, connectionId, layersWith } = await connectionOnlyFixture();
    const discover = fixedDiscovery({ [connectionId]: ['claude-opus-4-1'] });
    const resolution = await resolveModelForRun(layersWith({ anthropic: SONNET }), store, discover);
    expect(resolution).toMatchObject({ ok: false, layer: 'deployment', code: 'model_unavailable' });
    if (resolution.ok) throw new Error('unreachable');
    // The review of #506: the connection is the agent's; the deployment supplies only the id.
    expect(resolution.reason).toMatch(
      new RegExp(
        `^the deployment default model "${SONNET}" is not available at the agent's model connection "`,
        'u',
      ),
    );
  });

  it('refuses with model_credential_rejected when the provider rejects the key', async () => {
    const { store, layersWith } = await connectionOnlyFixture();
    const rejected = () =>
      Promise.resolve({
        ok: false as const,
        reason: 'The provider rejected the API key (HTTP 401).',
        failure: { kind: 'credential-rejected' as const, status: 401 },
      });
    await expect(
      resolveModelForRun(layersWith({ anthropic: SONNET }), store, rejected),
    ).resolves.toMatchObject({ ok: false, layer: 'deployment', code: 'model_credential_rejected' });
  });

  it('runs the same connection checks as every layer: a deleted connection is refused at deployment', async () => {
    const { store } = await connectionOnlyFixture();
    const discover = fixedDiscovery({});
    const resolution = await resolveModelForRun(
      {
        run: null,
        agent: null,
        project: null,
        workspace: null,
        deployment: { connectionId: crypto.randomUUID(), defaults: { anthropic: SONNET } },
      },
      store,
      discover,
    );
    expect(resolution).toMatchObject({
      ok: false,
      layer: 'deployment',
      code: 'model_connection_unresolved',
    });
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.reason).toMatch(/^the agent's model connection \S+ no longer exists/u);
  });

  it('keeps the workspace refusal for an agent with no connection at all', async () => {
    const { store } = await connectionOnlyFixture();
    await expect(
      resolveModelForRun(
        { run: null, agent: null, project: null, workspace: null, deployment: null },
        store,
        fixedDiscovery({}),
      ),
    ).resolves.toMatchObject({
      ok: false,
      layer: 'workspace',
      code: 'model_connection_unresolved',
      reason:
        'no model connection resolves for this run: the agent names none and no workspace default is configured.',
    });
  });

  it('refuses at the deployment layer, naming the missing default connection, when it has no connection', async () => {
    const { store } = await connectionOnlyFixture();
    await expect(
      resolveModelForRun(
        {
          run: null,
          agent: null,
          project: null,
          workspace: null,
          deployment: { connectionId: null, defaults: { anthropic: SONNET } },
        },
        store,
        fixedDiscovery({}),
      ),
    ).resolves.toEqual({
      ok: false,
      layer: 'deployment',
      code: 'model_connection_unresolved',
      reason: NO_DEFAULT_CONNECTION_REASON,
    });
    expect(NO_DEFAULT_CONNECTION_REASON).toContain('no connection named "default"');
  });
});

describe('buildRunRequestFor with code tools (ADR-0118 TS3, TS8)', () => {
  const TOOLS = [{ tool: 'get_order', digest: 'a'.repeat(64) }];
  const HOST_LOADER = {
    load: () =>
      Promise.resolve({
        files: [],
        skills: [],
        mcpServers: {
          host: { type: 'http' as const, url: 'https://tool-sandbox.invalid/mcp' },
          other: { type: 'http' as const, url: 'https://mcp.example.test' },
        },
        connectorNames: { host: 'aw-dev-tools', other: 'github' },
      }),
  };

  async function compose(
    settings: RuntimeSettings,
    loader: typeof HOST_LOADER | undefined,
    gateway: RunTokenIssuer = GATEWAY,
  ) {
    const { context, agents } = await launchContext();
    const runAgent: RunAgent = { ...(await rowRunAgent(agents, context)), toolBundles: TOOLS };
    return buildRunRequestFor(context, runAgent, settings, gateway, {}, ALL_ON, null, loader).then(
      (request) => ({ request, error: undefined, runId: context.run.id }),
      (error: unknown) => {
        if (!(error instanceof DomainError)) throw error;
        return { request: undefined, error, runId: context.run.id };
      },
    );
  }

  it('points the tool host connector at the gateway with the run token, never at the sandbox', async () => {
    // The real issuer, keyed by the signing secret the sandbox bearer derives from.
    const { request, runId } = await compose(
      { ...SETTINGS, toolSandbox: true },
      HOST_LOADER,
      createRunTokenIssuer({
        baseUrl: GATEWAY.baseUrl,
        signingSecret: SIGNING_SECRET,
        ttlSeconds: 300,
      }),
    );
    expect(request?.portable.mcpServers['host']).toEqual({
      type: 'http',
      url: 'http://gateway:4000/v1/tool-sandbox/mcp',
      headers: {
        authorization: `Bearer ${String(request?.gateway?.token)}`,
        'x-aw-agent': 'General',
      },
    });
    expect(request?.portable.mcpServers['other']).toEqual({
      type: 'http',
      url: 'https://mcp.example.test',
    });
    expect(JSON.stringify(request)).not.toContain('tool-sandbox.invalid');
    // The sandbox's own bearer is derived from the signing secret and never enters the request.
    const toolToken = await toolSandboxRunToken(SIGNING_SECRET, runId);
    expect(JSON.stringify(request)).not.toContain(toolToken);
  });

  it('refuses by name, before a token is issued, when the runtime has no tool sandbox', async () => {
    const before = issued;
    const { error } = await compose(SETTINGS, HOST_LOADER);
    expect(error?.code).toBe('code_tool_needs_host');
    expect(error?.publicMessage).toContain('get_order');
    expect(issued).toBe(before);
  });

  it('keeps the loopback header path for a pin whose tool host is a real host and no sandbox (TS7)', async () => {
    const loopback = {
      load: () =>
        Promise.resolve({
          files: [],
          skills: [],
          mcpServers: {
            host: { type: 'http' as const, url: 'http://127.0.0.1:9/mcp' },
            other: { type: 'http' as const, url: 'https://mcp.example.test' },
          },
          connectorNames: { host: 'aw-dev-tools', other: 'github' },
        }),
    };
    const { request, error, runId } = await compose(SETTINGS, loopback);
    expect(error).toBeUndefined();
    expect(request?.portable.mcpServers['host']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:9/mcp',
      headers: { 'x-aw-run-id': runId, 'x-aw-agent': 'General' },
    });
  });

  it('refuses by name when the tool host connector is not among the run’s servers', async () => {
    const { error } = await compose({ ...SETTINGS, toolSandbox: true }, undefined);
    expect(error?.code).toBe('code_tool_connector_missing');
    expect(error?.publicMessage).toContain('get_order');
  });
});

describe('withToolHostRunHeaders with a tool sandbox', () => {
  it('replaces only the tool host connector’s entry', () => {
    const servers = withToolHostRunHeaders(
      {
        files: [],
        skills: [],
        mcpServers: {
          host: { type: 'http', url: 'https://tool-sandbox.invalid/mcp', headers: { a: 'b' } },
          other: { type: 'http', url: 'https://mcp.example' },
        },
        connectorNames: { host: 'aw-dev-tools', other: 'github' },
      },
      'run-1',
      'サポート',
      { url: 'http://gateway:4000/v1/tool-sandbox/mcp', token: 'tok' },
    );
    expect(servers['host']).toEqual({
      type: 'http',
      url: 'http://gateway:4000/v1/tool-sandbox/mcp',
      headers: { authorization: 'Bearer tok', 'x-aw-agent': encodeURIComponent('サポート') },
    });
    expect(servers['other']).toEqual({ type: 'http', url: 'https://mcp.example' });
  });
});

const KEY = 'k'.repeat(32);
const MCP_ID = '00000000-0000-4000-8000-0000000000a1';
const TOOL_ID = '00000000-0000-4000-8000-0000000000a2';
const MCP_KEY = 'crm';
const optedInMcp: AgentRunResourceSelection = {
  files: [],
  skills: [],
  mcpServers: {
    [MCP_KEY]: {
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { 'X-Api-Key': 'kept', 'X-AW-Identity': 'forged' },
    },
  },
  connectorIdentities: { [MCP_KEY]: { connectorId: MCP_ID, key: KEY } },
};
const optedInTool: AgentRunResourceSelection = {
  files: [],
  skills: [],
  mcpServers: {},
  toolConnectors: [
    {
      key: 'orders',
      name: 'orders',
      connectorId: TOOL_ID,
      operationNames: ['getOrder'],
      identity: true,
    },
  ],
};
const member = { via: 'session', kind: 'membership' } as const;
const apiKey = { via: 'api-key', kind: 'api_key' } as const;

async function compose(
  resources: AgentRunResourceSelection,
  principal: Partial<LaunchContext['principal']>,
  subject?: string,
  builtin?: 'builder',
  options: { agent?: Partial<AgentRecord>; ceiling?: ProjectPolicy | null } = {},
) {
  const issued: unknown[] = [];
  const gateway: RunTokenIssuer = {
    baseUrl: 'http://gateway:4000',
    issue(claims) {
      issued.push(claims);
      return Promise.resolve('run-token');
    },
  };
  const { context, agents } = await launchContext();
  const row = await rowRunAgent(agents, context);
  const runAgent: RunAgent = {
    ...row,
    agent: { ...row.agent, ...(builtin === undefined ? {} : { builtin }), ...options.agent },
  };
  const run = () =>
    buildRunRequestFor(
      {
        ...context,
        principal: { ...context.principal, ...principal },
        ...(subject === undefined ? {} : { subject }),
      },
      runAgent,
      SETTINGS,
      gateway,
      {},
      undefined,
      null,
      { load: () => Promise.resolve(resources) },
      undefined,
      null,
      undefined,
      () => Promise.resolve(),
      options.ceiling ?? null,
    );
  return { run, issued };
}

describe('buildRunRequestFor — the daily cost cap claim (issue #1851)', () => {
  const none = { files: [], skills: [], mcpServers: {} };

  it('signs the ceiling’s maxCostPerDayUsd into the run token, so the gateway can stop the run', async () => {
    const { run, issued } = await compose(none, {}, undefined, undefined, {
      ceiling: { maxCostPerDayUsd: 5 },
    });
    await run();
    expect(issued).toEqual([expect.objectContaining({ dailyCostCapUsd: 5 })]);
  });

  it('signs no claim when there is no ceiling, or the ceiling sets no cap', async () => {
    for (const ceiling of [null, {}]) {
      const { run, issued } = await compose(none, {}, undefined, undefined, { ceiling });
      await run();
      expect(issued).toEqual([
        expect.not.objectContaining({ dailyCostCapUsd: expect.anything() as unknown }),
      ]);
    }
  });
});

describe('buildRunRequestFor — the identity assertion (ADR-0142)', () => {
  it('signs an assertion for the member, replaces a stored spelling of the header, and logs nothing', async () => {
    const spies = (['info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(webLogger, level).mockImplementation(() => undefined),
    );
    try {
      const { run, issued } = await compose(optedInMcp, member);
      const server = (await run()).portable.mcpServers[MCP_KEY] as {
        headers: Record<string, string>;
      };
      expect(Object.keys(server.headers).sort()).toEqual(['X-Api-Key', 'x-aw-identity']);
      const verified = await verifyIdentity(
        server.headers['x-aw-identity'] ?? '',
        KEY,
        new Date(),
        { audience: MCP_ID, workspace: WORKSPACE },
      );
      expect(verified).toMatchObject({
        ok: true,
        payload: { sub: USER, principalKind: 'membership', runId: RUN, aud: MCP_ID },
      });
      expect(issued).toEqual([
        expect.objectContaining({ caller: { sub: USER, principalKind: 'membership' } }),
      ]);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('asserts the subject an API key names', async () => {
    const { run, issued } = await compose(optedInTool, apiKey, 'customer-42');
    await run();
    expect(issued).toEqual([
      expect.objectContaining({ caller: { sub: 'customer-42', principalKind: 'api-key' } }),
    ]);
  });

  it.each([
    ['an MCP connector', optedInMcp],
    ['a tool connector', optedInTool],
  ])(
    'refuses before a token is issued when %s opted in and the run has no caller',
    async (_name, resources) => {
      for (const principal of [apiKey, {}]) {
        const { run, issued } = await compose(resources, principal);
        await expect(run()).rejects.toMatchObject({ code: 'connector_identity_unsupported' });
        expect(issued).toEqual([]);
      }
    },
  );

  it('leaves a run with no opted-in connector, and no caller, as it was', async () => {
    const { run, issued } = await compose({ files: [], skills: [], mcpServers: {} }, {});
    await run();
    expect(issued).toEqual([expect.not.objectContaining({ caller: expect.anything() as unknown })]);
  });
});

describe('buildRunRequestFor — the aw-control door (#1846)', () => {
  const mcp = (name: string): AgentRunResourceSelection => ({
    files: [],
    skills: [],
    mcpServers: { [MCP_KEY]: { type: 'http', url: 'https://mcp.example.test/mcp' } },
    connectorNames: { [MCP_KEY]: name },
  });
  const tool = (name: string): AgentRunResourceSelection => ({
    ...optedInTool,
    toolConnectors: [{ key: 'orders', name, connectorId: TOOL_ID, operationNames: ['getOrder'] }],
  });

  it.each([
    'aw-control',
    'AW-Control',
    'AW-CONTROL',
    ' aw-control ',
    '\taw-control',
    'aw-control\n',
  ])('refuses a run that reaches the connector name %j before a token is issued', async (name) => {
    for (const resources of [mcp(name), tool(name)]) {
      const { run, issued } = await compose(resources, member);
      await expect(run()).rejects.toMatchObject({ code: 'not_allowed_to_build' });
      expect(issued).toEqual([]);
    }
  });

  it.each([
    [
      'an MCP server key',
      {
        files: [],
        skills: [],
        mcpServers: { 'AW-Control': { type: 'http', url: 'https://mcp.example.test/mcp' } },
        connectorNames: { 'AW-Control': 'crm' },
      },
    ],
    [
      'a tool connector key',
      {
        ...optedInTool,
        toolConnectors: [
          {
            key: '\taw-control',
            name: 'orders',
            connectorId: TOOL_ID,
            operationNames: ['getOrder'],
          },
        ],
      },
    ],
  ] satisfies Array<[string, AgentRunResourceSelection]>)(
    'refuses %s equal to the reserved name, whatever the connector is called',
    async (_label, resources) => {
      const { run, issued } = await compose(resources, member);
      await expect(run()).rejects.toMatchObject({ code: 'not_allowed_to_build' });
      expect(issued).toEqual([]);
    },
  );

  it.each(['aw-control-2', 'aw_control', 'aw-dev-tools'])(
    'leaves the connector %j alone',
    async (name) => {
      const { run, issued } = await compose(mcp(name), member);
      await run();
      expect(issued).toHaveLength(1);
    },
  );

  it.each(['aw-control', 'AW-CONTROL', '\taw-control\n'])(
    'refuses a Builder run that selects the workspace connector %j',
    async (name) => {
      const { run, issued } = await compose(mcp(name), member, undefined, 'builder');
      await expect(run()).rejects.toMatchObject({ code: 'not_allowed_to_build' });
      expect(issued).toEqual([]);
    },
  );

  it('refuses the reserved name before asking for an identity the run has no caller for', async () => {
    const resources: AgentRunResourceSelection = {
      ...optedInMcp,
      connectorNames: { [MCP_KEY]: 'aw-control' },
    };
    const { run, issued } = await compose(resources, apiKey);
    await expect(run()).rejects.toMatchObject({ code: 'not_allowed_to_build' });
    expect(issued).toEqual([]);
  });
});

describe('buildRunRequestFor — who gets the aw-control tools (#1851 slice 2, B2)', () => {
  const NAME = 'hr-onboarding-coordinator';
  const ceiling: ProjectPolicy = { builder: { allow: [NAME] } };
  const none: AgentRunResourceSelection = { files: [], skills: [], mcpServers: {} };
  const madeByAgent = { agentId: null, version: 1, runId: 'run-1' } as const;
  const door = {
    type: 'http',
    url: 'http://gateway:4000/v1/tools/aw-control/mcp',
    headers: { authorization: 'Bearer run-token' },
  };
  const awControlOf = async (
    agent: Partial<AgentRecord>,
    ceilingForRun: ProjectPolicy | null,
    builtin?: 'builder',
  ) => {
    const { run } = await compose(none, member, undefined, builtin, {
      agent,
      ceiling: ceilingForRun,
    });
    return (await run()).portable.mcpServers['aw-control'];
  };

  it("[US-BLD-07][api][sdk] an allowed, person-made agent's run has the aw-control tools", async () => {
    expect(await awControlOf({ name: NAME }, ceiling)).toEqual(door);
  });

  it('gives the Builder the tools with no ceiling at all', async () => {
    expect(await awControlOf({ name: 'builder' }, null, 'builder')).toEqual(door);
  });

  it('does not give an allowed agent made by an agent the tools', async () => {
    expect(await awControlOf({ name: NAME, createdByAgent: madeByAgent }, ceiling)).toBeUndefined();
  });

  it.each([
    ['an unlisted name', { name: 'other' }, ceiling],
    ['no ceiling', { name: NAME }, null],
    ['an empty allow-list', { name: NAME }, { builder: { allow: [] } }],
    ['a different case', { name: 'HR-Onboarding-Coordinator' }, ceiling],
    ['leading padding', { name: ` ${NAME}` }, ceiling],
    ['trailing padding', { name: `${NAME} ` }, ceiling],
  ] satisfies Array<[string, Partial<AgentRecord>, ProjectPolicy | null]>)(
    'does not give an agent with %s the tools',
    async (_label, agent, ceilingForRun) => {
      expect(await awControlOf(agent, ceilingForRun)).toBeUndefined();
    },
  );

  it('still refuses an allowed agent that reaches a workspace connector of that name', async () => {
    const connector: AgentRunResourceSelection = {
      ...none,
      mcpServers: { [MCP_KEY]: { type: 'http', url: 'https://mcp.example.test/mcp' } },
      connectorNames: { [MCP_KEY]: 'aw-control' },
    };
    const { run, issued } = await compose(connector, member, undefined, undefined, {
      agent: { name: NAME },
      ceiling,
    });
    await expect(run()).rejects.toMatchObject({ code: 'not_allowed_to_build' });
    expect(issued).toEqual([]);
  });
});
