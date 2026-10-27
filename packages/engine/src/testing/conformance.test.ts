/**
 * The conformance kit's self-test: every scenario, against the scripted engine.
 *
 * Two things are being checked and the second is the one a reader should look at first.
 *
 *  1. **The scripted engine passes every scenario.** That is the acceptance criterion, and it is
 *     what makes the kit usable as the second row against the Claude adapter — a scenario the
 *     double cannot pass is a scenario about Claude rather than about the port.
 *
 *  2. **The scenarios can fail.** A kit whose scenarios were vacuously true would report PASS
 *     for an adapter that did nothing, which is the same defect as a gate that passes because it
 *     could not run (ADR-0015). So each negative below breaks one property deliberately and
 *     asserts that the scenario about it — and, where it matters, *only* that scenario — turns
 *     red.
 */
import { describe, expect, it } from 'vitest';

import type { EngineRunRequest } from '../port.js';
import {
  CONFORMANCE_SCENARIOS,
  expectConformance,
  runEngineConformance,
  type EngineConformanceSubject,
} from './conformance.js';
import { createScriptedGateway } from './gateway.js';
import {
  createScriptedEngine,
  SCRIPTED_ENGINE_ID,
  SCRIPTED_PROTECTED_CONFIG_DIRECTORY,
  scriptedOptionsAllowPermission,
  scriptedOptionsAllowWrite,
  type ScriptedCompiledOptions,
} from './scripted-engine.js';

function subjectFor(
  engine = createScriptedEngine(),
): EngineConformanceSubject<ScriptedCompiledOptions> {
  return {
    engine,
    policy: { kind: 'scripted', label: 'conformance' },
    unreadablePolicy: { kind: 'something-else' },
    compiledEnv: (compiled) => compiled.env,
    writeAllowed: scriptedOptionsAllowWrite,
    permissionAllowed: scriptedOptionsAllowPermission,
    connectorsCompiled: (compiled) => compiled.connectors,
  };
}

/** A request built by hand, for the scripted engine's own refusals rather than for the kit. */
const BARE_REQUEST = {
  runId: '3f1b9f7e-1d3a-4a31-9a6c-0f2a1d9b7c41',
  sessionId: '9c2e5a44-0b61-4f6a-9f2c-6f0b3d8c1a22',
  projectKey: 'tenant-a',
  cwd: '/workspace/x',
  prompt: 'go',
  engine: SCRIPTED_ENGINE_ID,
  portable: {
    name: 'Scripted',
    instructions: '',
    model: null,
    permissions: {
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: true,
    },
    skills: { mode: 'allowlist', names: [] },
    mcpServers: {},
    limits: { maxTurns: null, maxBudgetUsd: null },
  },
  policy: { kind: 'scripted' },
  resources: { files: [], skills: [] },
  env: {},
} as const satisfies Omit<EngineRunRequest, 'session' | 'gateway'>;

async function failedScenarios(
  subject: EngineConformanceSubject<ScriptedCompiledOptions>,
): Promise<string[]> {
  const verdicts = await runEngineConformance(subject);
  return verdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.scenario);
}

describe('the conformance kit against the scripted engine', () => {
  it('reports PASS for every scenario', async () => {
    const verdicts = await expectConformance(subjectFor());
    expect(verdicts).toHaveLength(CONFORMANCE_SCENARIOS.length);
    for (const verdict of verdicts) {
      expect(verdict.pass, `${verdict.scenario}: ${verdict.pass ? '' : verdict.reason}`).toBe(true);
      // Every passing verdict says what it observed, so a scenario that silently stopped
      // exercising anything is visible rather than green.
      expect(verdict.pass ? verdict.detail : '').not.toBe('');
    }
  });

  it('has a scenario list with no duplicate names, so a report names one thing each', () => {
    const names = CONFORMANCE_SCENARIOS.map((scenario) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(0);
  });
});

describe('the kit fails an adapter that breaks one of its properties', () => {
  it('fails the read-only-grant scenario, and only it, for an engine that ignores file grants', async () => {
    // A deliberately non-conforming adapter: it compiles every request as though no file were
    // granted, so its tool grammar allows a write anywhere. Before ENG-04's review the scenario
    // consulted the kit's own helper instead of the adapter, and this engine passed it.
    const ignoresGrants = { ...createScriptedEngine() };
    const compile = ignoresGrants.compile.bind(ignoresGrants);
    ignoresGrants.compile = (request) => {
      const result = compile(request);
      return result.ok ? { ...result, compiled: { ...result.compiled, grants: [] } } : result;
    };
    const failed = await failedScenarios(subjectFor(ignoresGrants));
    expect(failed).toEqual(['a-read-only-grant-is-not-writable']);
  });

  it('fails the permission scenario, and only it, for an engine that ignores the tool policy', async () => {
    // ENG-04b's negative adapter for Deviation 7. It compiles every request as though every
    // permission switch were on, which is exactly what an adapter that reads `portable.permissions`
    // and forgets to compile anything from it produces — and before this scenario existed, no
    // engine-neutral check could see it, because the tools a switch removes are named in the
    // adapter's own vocabulary.
    const ignoresPermissions = { ...createScriptedEngine() };
    const compile = ignoresPermissions.compile.bind(ignoresPermissions);
    ignoresPermissions.compile = (request) => {
      const result = compile(request);
      return result.ok
        ? {
            ...result,
            compiled: {
              ...result.compiled,
              allowed: {
                readFiles: true,
                writeFiles: true,
                runCommands: true,
                unrestrictedNetwork: true,
              },
            },
          }
        : result;
    };
    const failed = await failedScenarios(subjectFor(ignoresPermissions));
    expect(failed).toEqual(['the-portable-permissions-decide-the-tool-policy']);
  });

  it('fails the permission scenario for an engine that forbids a capability whatever the request says', async () => {
    // The other direction, and the vacuity control for the scenario above: an adapter that always
    // refuses is not conformant either, and the scenario must not pass it by mistaking a blanket
    // refusal for an honoured switch.
    const forbidsEverything = { ...createScriptedEngine() };
    const compile = forbidsEverything.compile.bind(forbidsEverything);
    forbidsEverything.compile = (request) => {
      const result = compile(request);
      return result.ok
        ? {
            ...result,
            compiled: {
              ...result.compiled,
              allowed: { ...result.compiled.allowed, runCommands: false },
            },
          }
        : result;
    };
    expect(await failedScenarios(subjectFor(forbidsEverything))).toContain(
      'the-portable-permissions-decide-the-tool-policy',
    );
  });

  it('fails the skills scenario, and only it, for an engine that writes skills outside its config directory', async () => {
    // ENG-04b's negative adapter for Deviation 8. It places skills at the sandbox root instead of
    // under the directory it declares, which is where a tenant's `SKILL.md` would sit beside the
    // agent's own working files — readable and writable by tools the platform never scoped to it.
    const escapes = { ...createScriptedEngine() };
    escapes.placeSkills = (request) =>
      request.resources.skills.flatMap((skill) =>
        skill.files.map((file) => ({
          skill: skill.name,
          path: `skills/${skill.name}/${file.path}`,
          contentBase64: file.contentBase64,
        })),
      );
    const failed = await failedScenarios(subjectFor(escapes));
    expect(failed).toEqual(['skills-are-placed-inside-the-declared-config-directory']);
  });

  it('fails the skills scenario for an engine that places nothing at all', async () => {
    const silentSkills = { ...createScriptedEngine() };
    silentSkills.placeSkills = () => [];
    expect(await failedScenarios(subjectFor(silentSkills))).toContain(
      'skills-are-placed-inside-the-declared-config-directory',
    );
  });

  it('fails the skills scenario for an engine that climbs out of the workspace', async () => {
    const climbs = { ...createScriptedEngine() };
    climbs.placeSkills = (request) =>
      request.resources.skills.flatMap((skill) =>
        skill.files.map((file) => ({
          skill: skill.name,
          path: `${SCRIPTED_PROTECTED_CONFIG_DIRECTORY}/../../${skill.name}/${file.path}`,
          contentBase64: file.contentBase64,
        })),
      );
    expect(await failedScenarios(subjectFor(climbs))).toContain(
      'skills-are-placed-inside-the-declared-config-directory',
    );
  });

  it('passes an engine that declares skills: false and refuses them by name', async () => {
    // ENG-09 (#308): the OpenAI Agents SDK's plain `Agent` has no skills, and ADR-0065 D4 makes
    // skills portable-with-refusal. Before this arm the scenario demanded a placement from every
    // engine, so no skill-less adapter could pass the kit without inventing a skills loader.
    const verdicts = await expectConformance(
      subjectFor(createScriptedEngine({ capabilities: { skills: false } })),
    );
    const skills = verdicts.find(
      (verdict) => verdict.scenario === 'skills-are-placed-inside-the-declared-config-directory',
    );
    expect(skills?.pass ? skills.detail : '').toContain('skills: false declared');
  });

  it('fails the skills scenario, and only it, for a skills: false engine that compiles skills anyway', async () => {
    const dropsSkills = { ...createScriptedEngine({ capabilities: { skills: false } }) };
    const compile = dropsSkills.compile.bind(dropsSkills);
    // It removes the skills before compiling, so a granted skill is silently dropped rather than
    // refused — the ADR-0065 D3 failure the arm exists to catch.
    dropsSkills.compile = (request) =>
      compile({ ...request, resources: { ...request.resources, skills: [] } });
    const failed = await failedScenarios(subjectFor(dropsSkills));
    expect(failed).toEqual(['skills-are-placed-inside-the-declared-config-directory']);
  });

  it('fails the skills scenario for a skills: false engine whose refusal does not name the skills', async () => {
    const vague = { ...createScriptedEngine({ capabilities: { skills: false } }) };
    const compile = vague.compile.bind(vague);
    // The right code, but a reason about something else: a control plane cannot tell the author
    // which grant to remove.
    vague.compile = (request) => {
      const verdict = compile(request);
      return verdict.ok ||
        request.portable.subagents !== undefined ||
        request.outputSchema !== undefined
        ? verdict
        : { ...verdict, reason: 'this engine cannot run the request.' };
    };
    expect(await failedScenarios(subjectFor(vague))).toEqual([
      'skills-are-placed-inside-the-declared-config-directory',
    ]);
  });

  it('fails the skills scenario for a skills: false engine that still places skill files', async () => {
    const placesAnyway = { ...createScriptedEngine({ capabilities: { skills: false } }) };
    const withSkills = createScriptedEngine();
    placesAnyway.placeSkills = (request) => withSkills.placeSkills(request);
    expect(await failedScenarios(subjectFor(placesAnyway))).toEqual([
      'skills-are-placed-inside-the-declared-config-directory',
    ]);
  });

  it('passes an engine that declares mcp: false and refuses connectors by name (ENG-08, #307)', async () => {
    const verdicts = await expectConformance(
      subjectFor(createScriptedEngine({ capabilities: { mcp: false } })),
    );
    const mcp = verdicts.find(
      (verdict) => verdict.scenario === 'connectors-are-honoured-or-refused-by-name',
    );
    expect(mcp?.pass ? mcp.detail : '').toContain('typed refusal');
  });

  it('fails the connector scenario, and only it, for an mcp: false engine that drops connectors', async () => {
    const dropsConnectors = { ...createScriptedEngine({ capabilities: { mcp: false } }) };
    const compile = dropsConnectors.compile.bind(dropsConnectors);
    dropsConnectors.compile = (request) =>
      compile({ ...request, portable: { ...request.portable, mcpServers: {} } });
    expect(await failedScenarios(subjectFor(dropsConnectors))).toEqual([
      'connectors-are-honoured-or-refused-by-name',
    ]);
  });

  it('fails the connector scenario, and only it, for an mcp: true engine that drops connectors', async () => {
    const dropsConnectors = { ...createScriptedEngine() };
    const compile = dropsConnectors.compile.bind(dropsConnectors);
    dropsConnectors.compile = (request) =>
      compile({ ...request, portable: { ...request.portable, mcpServers: {} } });
    expect(await failedScenarios(subjectFor(dropsConnectors))).toEqual([
      'connectors-are-honoured-or-refused-by-name',
    ]);
  });

  it('says an mcp: true subject without connectorsCompiled was only checked for not refusing', async () => {
    const verdicts = await expectConformance({
      ...subjectFor(),
      connectorsCompiled: undefined,
    });
    const mcp = verdicts.find(
      (verdict) => verdict.scenario === 'connectors-are-honoured-or-refused-by-name',
    );
    expect(mcp?.pass ? mcp.detail : '').toContain('not refused');
  });

  it('fails the connector scenario for an mcp: false engine whose refusal does not name them', async () => {
    const vague = { ...createScriptedEngine({ capabilities: { mcp: false } }) };
    const compile = vague.compile.bind(vague);
    vague.compile = (request) => {
      const verdict = compile(request);
      return verdict.ok ||
        request.portable.subagents !== undefined ||
        request.outputSchema !== undefined
        ? verdict
        : { ...verdict, reason: 'this engine cannot run the request.' };
    };
    expect(await failedScenarios(subjectFor(vague))).toEqual([
      'connectors-are-honoured-or-refused-by-name',
    ]);
  });

  it('fails the subagent scenario, and only it, for a subagents: true engine that drops them', async () => {
    const accepts = createScriptedEngine({ capabilities: { subagents: true } });
    expect(await failedScenarios({ ...subjectFor(accepts), subagentsCompiled: () => [] })).toEqual([
      'subagents-are-honoured-or-refused-by-name',
    ]);
    expect(
      await failedScenarios({
        ...subjectFor(accepts),
        subagentsCompiled: () => ['billing-specialist'],
      }),
    ).toEqual([]);
  });

  it('fails the subagent scenario, and only it, for a subagents: true subject without subagentsCompiled', async () => {
    const accepts = createScriptedEngine({ capabilities: { subagents: true } });
    expect(await failedScenarios(subjectFor(accepts))).toEqual([
      'subagents-are-honoured-or-refused-by-name',
    ]);
  });

  it('fails the subagent scenario for a subagents: false engine whose refusal does not name them', async () => {
    const vague = { ...createScriptedEngine() };
    const compile = vague.compile.bind(vague);
    vague.compile = (request) => {
      const verdict = compile(request);
      return verdict.ok || request.outputSchema !== undefined
        ? verdict
        : { ...verdict, reason: 'this engine cannot run the request.' };
    };
    expect(await failedScenarios(subjectFor(vague))).toEqual([
      'subagents-are-honoured-or-refused-by-name',
    ]);
  });

  it('fails the output-schema scenario, and only it, for a subject that expects the schema compiled where the engine refuses it', async () => {
    expect(
      await failedScenarios({ ...subjectFor(), outputSchemaCompiled: () => undefined }),
    ).toEqual(['an-output-schema-is-honoured-or-refused-by-name']);
  });

  it('fails the output-schema scenario for an engine that refuses it without naming it', async () => {
    const vague = { ...createScriptedEngine() };
    const compile = vague.compile.bind(vague);
    vague.compile = (request) => {
      const verdict = compile(request);
      return verdict.ok ? verdict : { ...verdict, reason: 'this engine cannot run the request.' };
    };
    expect(await failedScenarios(subjectFor(vague))).toContain(
      'an-output-schema-is-honoured-or-refused-by-name',
    );
  });

  it('fails the read-only-grant scenario for an engine that forbids every write', async () => {
    const failed = await failedScenarios({ ...subjectFor(), writeAllowed: () => false });
    expect(failed).toContain('a-read-only-grant-is-not-writable');
  });

  it('fails the protected-directory scenario, and only it, for an engine that compiles a grant into it', async () => {
    const acceptsAnyPath = { ...createScriptedEngine() };
    const compile = acceptsAnyPath.compile.bind(acceptsAnyPath);
    // It drops every grant that names its own config directory before compiling, so such a
    // grant is compiled rather than refused; every other grant is still honoured.
    acceptsAnyPath.compile = (request) =>
      compile({
        ...request,
        resources: {
          ...request.resources,
          files: request.resources.files.filter(
            (file) => !file.path.includes(SCRIPTED_PROTECTED_CONFIG_DIRECTORY),
          ),
        },
      });
    const failed = await failedScenarios(subjectFor(acceptsAnyPath));
    expect(failed).toEqual(['the-protected-config-directory-is-declared-and-closed']);
  });

  it('fails the credential scenario for an engine that drops the declared credential', async () => {
    const dropsEnv = { ...createScriptedEngine() };
    const compile = dropsEnv.compile.bind(dropsEnv);
    dropsEnv.compile = (request) => {
      const result = compile(request);
      return result.ok ? { ...result, compiled: { ...result.compiled, env: {} } } : result;
    };
    const failed = await failedScenarios({
      ...subjectFor(dropsEnv),
      gatewayEnv: (connection) => ({ SCRIPTED_DECLARED_AUTH_TOKEN: connection.token }),
    });
    expect(failed).toContain('no-provider-credential-in-the-sandbox');
    expect(failed).toContain('gateway-is-programmatic');
  });

  it('fails the policy scenario for an engine that accepts any policy', async () => {
    const permissive = { ...createScriptedEngine() };
    const compile = permissive.compile.bind(permissive);
    permissive.compile = (request) =>
      compile({ ...request, policy: { kind: 'scripted', label: 'forced' } });
    const failed = await failedScenarios({
      ...subjectFor(permissive),
      unreadablePolicy: { kind: 'something-else' },
    });
    expect(failed).toContain('compile-refuses-an-unreadable-policy');
  });

  it('fails the credential scenario for an engine that puts a provider key in the sandbox', async () => {
    const leaky = { ...createScriptedEngine() };
    const compile = leaky.compile.bind(leaky);
    leaky.compile = (request) => {
      const result = compile(request);
      if (!result.ok) return result;
      return {
        ok: true,
        compiled: {
          ...result.compiled,
          env: { ...result.compiled.env, ANTHROPIC_API_KEY: 'sk-ant-real-key' },
        },
      };
    };
    expect(await failedScenarios(subjectFor(leaky))).toContain(
      'no-provider-credential-in-the-sandbox',
    );
  });

  it('fails the session scenario for an engine that invents a session id nothing reported', async () => {
    const inventing = createScriptedEngine({
      // No `session` message in the script, so nothing ever reports an id …
      script: [{ kind: 'result', stopReason: 'end_turn', turns: 1 }],
    });
    const liar = { ...inventing };
    const start = liar.start.bind(liar);
    liar.start = (request, context) => ({
      ...start(request, context),
      // … and yet the connection answers with one.
      engineSessionId: Promise.resolve('invented-from-the-request'),
    });
    expect(await failedScenarios(subjectFor(liar))).toContain(
      'the-session-id-is-reported-not-invented',
    );
  });

  it('fails the durability scenario for an engine that claims durability with no store', async () => {
    const optimistic = { ...createScriptedEngine() };
    const start = optimistic.start.bind(optimistic);
    optimistic.start = (request, context) => ({
      ...start(request, context),
      sessionDurability: () => ({ durable: true, mirroredBatches: 3 }),
    });
    expect(await failedScenarios(subjectFor(optimistic))).toContain(
      'durability-without-a-store-is-a-reasoned-no',
    );
  });

  it('fails the neutral-frame scenario for an engine whose frames name another engine', async () => {
    const mislabelled = { ...createScriptedEngine() };
    const start = mislabelled.start.bind(mislabelled);
    mislabelled.start = (request, context) => {
      const connection = start(request, context);
      return {
        ...connection,
        frames: (async function* () {
          for await (const frame of connection.frames) yield { ...frame, engine: 'someone-else' };
        })(),
      };
    };
    expect(await failedScenarios(subjectFor(mislabelled))).toContain(
      'every-frame-is-neutral-and-named-by-this-engine',
    );
  });

  it('fails the frame and durability scenarios for an engine that produces no frames at all', async () => {
    // The vacuity control: an adapter that yields nothing must not look like one that behaved.
    // The session scenario is deliberately *not* among the failures — a run that reported no
    // session and whose `engineSessionId` rejected is the honest pair, which is exactly what
    // that scenario is about.
    const silent = createScriptedEngine({ script: [] });
    const failed = await failedScenarios(subjectFor(silent));
    expect(failed).toContain('every-frame-is-neutral-and-named-by-this-engine');
    expect(failed).toContain('durability-with-a-store-is-earned');
    expect(failed).not.toContain('the-session-id-is-reported-not-invented');
  });
});

describe('expectConformance', () => {
  it('throws with every failing scenario named, so one run says what broke', async () => {
    const broken = { ...createScriptedEngine() };
    broken.compile = () => ({
      ok: false,
      code: 'engine_policy_invalid',
      reason: 'this engine refuses everything',
    });
    await expect(expectConformance(subjectFor(broken))).rejects.toThrow(
      /conformance scenarios failed for engine scripted-test-engine/u,
    );
  });
});

describe('the scripted engine itself', () => {
  it('refuses a request with no gateway connection rather than finding a credential elsewhere', () => {
    const engine = createScriptedEngine();
    const gateway = createScriptedGateway();
    const base = {
      ...BARE_REQUEST,
      session: { mode: 'fresh' } as const,
    };
    expect(engine.compile({ ...base, gateway: gateway.connection }).ok).toBe(true);
    const refused = engine.compile({ ...base, gateway: null });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.code).toBe('engine_credential_refused');
  });

  it('refuses a capability it declares it does not have', () => {
    const noFork = createScriptedEngine({ capabilities: { fork: false } });
    const gateway = createScriptedGateway();
    const refused = noFork.compile({
      ...BARE_REQUEST,
      session: { mode: 'fork', engineSessionId: 'prior' },
      gateway: gateway.connection,
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.code).toBe('engine_capability_unsupported');
  });
});
