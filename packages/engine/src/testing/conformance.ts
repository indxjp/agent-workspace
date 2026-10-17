/**
 * The engine conformance kit (ENG-04, #303).
 *
 * One list of scenarios, run against **every** adapter. The point is not that each scenario is
 * hard; it is that the same sentences are asserted about the Claude Agent SDK adapter and about
 * the scripted double, so a property that holds only because of how one engine happens to behave
 * shows up as a scenario the other fails.
 *
 * ## Why a scenario returns a verdict instead of calling `expect`
 *
 * The kit is a library in `packages/engine`, which has no test framework on its dependency list
 * and must not acquire one — an adapter package, a runner test and (later) a deployment
 * smoke-test all want to run these, and only the first two are inside vitest. So a scenario is
 * `(subject) => Promise<ScenarioVerdict>` and the caller turns a verdict into whatever its own
 * framework calls a failure. `expectConformance` below is that turn for vitest-shaped callers,
 * written without importing vitest: it throws, and vitest reports a throw as a failure.
 *
 * ## Every verdict says what it observed
 *
 * ADR-0015 applied to a conformance kit: a scenario that answered `pass: true` with nothing
 * attached would pass identically when the thing it was about had silently stopped happening —
 * a compile that returned early, a stream with no frames in it. So the passing arm carries a
 * `detail` naming what it saw, and the scenarios that count something count it.
 */
import type { AgentPermissionKey } from '@indx-workspace/contracts/agents';

import { isCredentialEnvName, sandboxEnvironmentVerdict } from '../sandbox-env.js';
import { normaliseGrants, writeGrantVerdict } from '../path-grant.js';
import { skillPlacementVerdict } from '../skills.js';
import type {
  AgentEngine,
  EngineGatewayConnection,
  EnginePortableConfig,
  EngineSubagent,
  EngineRunRequest,
  EngineSkillGrant,
} from '../port.js';
import { withStoreWriteFailures } from '../session-state.js';
import { createFakeSessionStore } from './session-store.js';
import { createScriptedGateway, type ScriptedGateway } from './gateway.js';

export type ScenarioVerdict =
  | { readonly scenario: string; readonly pass: true; readonly detail: string }
  | { readonly scenario: string; readonly pass: false; readonly reason: string };

/**
 * What an adapter has to supply for the kit to be able to build a request it will accept.
 *
 * The policy arm is engine-native by construction, so the kit cannot invent one — and asking the
 * adapter for it is not a loophole: `unreadablePolicy` is asked for in the same breath, and the
 * scenario that uses it asserts the adapter *refuses* it with the port's own code.
 */
export type EngineConformanceSubject<TCompiled> = {
  readonly engine: AgentEngine<TCompiled>;
  /** A policy arm this engine accepts. */
  readonly policy: unknown;
  /** A policy arm this engine must refuse with `engine_policy_invalid`. */
  readonly unreadablePolicy: unknown;
  /** The compiled sandbox environment, read out of this engine's own options type. */
  readonly compiledEnv: (compiled: TCompiled) => Readonly<Record<string, string>>;
  /**
   * Does this engine's compiled options let the agent write `path` (workspace-relative)?
   *
   * The adapter's reading of its **own** tool-permission grammar, and the equivalent of
   * {@link compiledEnv} for file grants: the grant scenarios compile a request carrying a
   * read-only grant and ask this about the result, so an adapter that ignores grants, or
   * compiles a rule that does not cover what the grant covers, fails them.
   */
  readonly writeAllowed: (compiled: TCompiled, path: string) => boolean;
  /**
   * Does this engine's compiled options still allow what one of §17 Step 4's four permission
   * switches governs?
   *
   * The equivalent of {@link writeAllowed} for the *portable* half of the tool policy, and the
   * reason ENG-04b could move the Claude tool mapping into its adapter with a scenario watching:
   * `permissions` is the only tool-permission input on the wire, so an adapter that read it and
   * did nothing with it would produce a run wider than its author wrote — and nothing engine-neutral
   * could have noticed, because the tool *names* are the adapter's own.
   */
  readonly permissionAllowed: (compiled: TCompiled, permission: AgentPermissionKey) => boolean;
  /**
   * The connector names this engine's compiled options will hand the engine — the equivalent of
   * {@link writeAllowed} for the portable `mcpServers`.
   *
   * Declared by every adapter that declares `mcp: true`, so the connector scenario can tell an
   * adapter that compiles a granted connector from one that accepts the request and silently
   * drops it. An `mcp: false` adapter omits it: its scenario asserts the refusal instead.
   */
  readonly connectorsCompiled?: ((compiled: TCompiled) => readonly string[]) | undefined;
  /**
   * The subagent names this engine's compiled options will hand the engine — {@link connectorsCompiled}
   * for the portable `subagents`. Declared by every adapter that declares `subagents: true`, so the
   * scenario can tell one that compiles a subagent from one that accepts it and drops it.
   */
  readonly subagentsCompiled?: ((compiled: TCompiled) => readonly string[]) | undefined;
  /**
   * The environment variables this engine still reads its gateway connection from, built from
   * the connection the request carries. Merged into every conformance request's `env`.
   *
   * Absent for an engine that takes the connection programmatically. Present for the Claude
   * adapter, whose pre-v2 body carries `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` in `env`
   * (ADR-0070) — and declaring it is what lets the credential scenarios check the shape a real
   * run has rather than an environment with no credential in it at all.
   */
  readonly gatewayEnv?:
    ((connection: EngineGatewayConnection) => Readonly<Record<string, string>>) | undefined;
  /** Override the gateway the requests carry. Defaults to a scripted one. */
  readonly gateway?: ScriptedGateway | undefined;
};

export type EngineConformanceScenario = {
  readonly name: string;
  readonly about: string;
  /**
   * A scenario answers a verdict, synchronously or not.
   *
   * The union is not laziness: six of the scenarios below decide entirely from `compile`, which
   * is pure, and writing them `async` to satisfy one signature would claim an asynchrony they do
   * not have — and would let a reader assume every scenario starts a run. {@link runEngineConformance}
   * awaits the result either way.
   */
  run<TCompiled>(
    subject: EngineConformanceSubject<TCompiled>,
  ): ScenarioVerdict | Promise<ScenarioVerdict>;
};

function pass(scenario: string, detail: string): ScenarioVerdict {
  return { scenario, pass: true, detail };
}
function fail(scenario: string, reason: string): ScenarioVerdict {
  return { scenario, pass: false, reason };
}

const RUN_ID = '3f1b9f7e-1d3a-4a31-9a6c-0f2a1d9b7c41';
const SESSION_ID = '9c2e5a44-0b61-4f6a-9f2c-6f0b3d8c1a22';
const PROJECT_KEY = 'conformance-tenant';

/**
 * The portable core every conformance request carries: an unrestricted agent.
 *
 * Unrestricted on purpose. The grant and permission scenarios each *narrow* one thing and compare
 * against this baseline, and a baseline that already forbade something would let an adapter that
 * forbids everything pass them.
 */
const PERMISSIVE_PORTABLE: EnginePortableConfig = {
  name: 'Conformance agent',
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
};

/** A request the subject's engine should accept, with the fields a scenario wants overridden. */
function requestFor<TCompiled>(
  subject: EngineConformanceSubject<TCompiled>,
  gateway: ScriptedGateway,
  overrides: Partial<EngineRunRequest> = {},
): EngineRunRequest {
  return {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    projectKey: PROJECT_KEY,
    cwd: '/workspace/conformance',
    prompt: 'summarise the attached document',
    engine: subject.engine.id,
    portable: PERMISSIVE_PORTABLE,
    policy: subject.policy,
    session: { mode: 'fresh' },
    gateway: gateway.connection,
    resources: { files: [], skills: [] },
    env: {
      PATH: '/usr/bin',
      HOME: '/workspace/conformance',
      ...(subject.gatewayEnv?.(gateway.connection) ?? {}),
    },
    ...overrides,
  };
}

/** The same request with exactly one permission switch turned off. */
function withPermissionOff<TCompiled>(
  subject: EngineConformanceSubject<TCompiled>,
  gateway: ScriptedGateway,
  permission: AgentPermissionKey,
): EngineRunRequest {
  return requestFor(subject, gateway, {
    portable: {
      ...PERMISSIVE_PORTABLE,
      permissions: { ...PERMISSIVE_PORTABLE.permissions, [permission]: false },
    },
  });
}

/** Two skills with two files each — enough for a placement to collide or to be dropped. */
const CONFORMANCE_SKILLS: readonly EngineSkillGrant[] = [
  {
    name: 'invoice-review',
    files: [
      { path: 'SKILL.md', contentBase64: 'IyBJbnZvaWNlcw==' },
      { path: 'reference/rates.md', contentBase64: 'cmF0ZXM=' },
    ],
  },
  { name: 'document-writer', files: [{ path: 'SKILL.md', contentBase64: 'IyBXcml0ZQ==' }] },
];

/** One remote connector, in the record shape `packages/core`'s `McpServerConfig` stores. */
const CONFORMANCE_CONNECTORS: Readonly<Record<string, unknown>> = {
  'conformance-docs': { type: 'http', url: 'https://mcp.example.com/mcp' },
};

/** One subagent, as `packages/core`'s `PortableSubagentConfig` carries it. */
const CONFORMANCE_SUBAGENT: EngineSubagent = {
  name: 'billing-specialist',
  description: 'Answers billing questions.',
  instructions: 'You answer billing questions.',
  model: null,
  permissions: PERMISSIVE_PORTABLE.permissions,
};

const PERMISSION_KEYS: readonly AgentPermissionKey[] = [
  'readFiles',
  'writeFiles',
  'runCommands',
  'unrestrictedNetwork',
];

function gatewayFor<TCompiled>(subject: EngineConformanceSubject<TCompiled>): ScriptedGateway {
  return subject.gateway ?? createScriptedGateway();
}

/**
 * The scenarios, in the order a reader should meet them: compile first (it is pure and cheap),
 * then the safety properties the compile decides, then the run.
 */
export const CONFORMANCE_SCENARIOS: readonly EngineConformanceScenario[] = [
  {
    name: 'compile-is-pure',
    about: 'compiling the same request twice produces the same options',
    run(subject) {
      const request = requestFor(subject, gatewayFor(subject));
      const first = subject.engine.compile(request);
      const second = subject.engine.compile(request);
      if (!first.ok) return fail(this.name, `the first compile refused: ${first.reason}`);
      if (!second.ok) return fail(this.name, `the second compile refused: ${second.reason}`);
      const a = JSON.stringify(first.compiled);
      const b = JSON.stringify(second.compiled);
      if (a !== b) {
        return fail(this.name, `two compiles of one request differed:\n  ${a}\n  ${b}`);
      }
      return pass(this.name, `compiled ${String(a.length)} bytes of options, twice, identically`);
    },
  },
  {
    name: 'compile-refuses-an-unreadable-policy',
    about: 'a policy arm this engine cannot read is engine_policy_invalid, never a default',
    run(subject) {
      const request = requestFor(subject, gatewayFor(subject), {
        policy: subject.unreadablePolicy,
      });
      const result = subject.engine.compile(request);
      if (result.ok) {
        return fail(
          this.name,
          'the engine compiled a policy the subject declared unreadable. A policy that cannot be read must be refused, never defaulted — a run started with default policy is a run whose author believes it is narrower than it is.',
        );
      }
      if (result.code !== 'engine_policy_invalid') {
        return fail(this.name, `expected engine_policy_invalid; got ${result.code}`);
      }
      return pass(this.name, `refused with engine_policy_invalid: ${result.reason}`);
    },
  },
  {
    name: 'no-provider-credential-in-the-sandbox',
    about:
      'spec A.11 — ANTHROPIC_API_KEY is absent and every credential-shaped variable is the run token',
    run(subject) {
      const gateway = gatewayFor(subject);
      const request = requestFor(subject, gateway);
      const result = subject.engine.compile(request);
      if (!result.ok) return fail(this.name, `the compile refused: ${result.reason}`);
      const verdict = sandboxEnvironmentVerdict(
        subject.compiledEnv(result.compiled),
        gateway.connection.token,
      );
      if (!verdict.ok) return fail(this.name, `${verdict.variable}: ${verdict.reason}`);
      // A verdict over an environment with no credential in it passes by looking at nothing. If
      // the request carried a credential-shaped variable, the compiled environment must still
      // have one for this scenario to have checked anything — and a compile that dropped it
      // would be a run that cannot reach its model.
      const declared = Object.keys(request.env).filter(isCredentialEnvName);
      if (declared.length > 0 && verdict.checked === 0) {
        return fail(
          this.name,
          `the request carried ${declared.join(', ')} and the compiled environment has no credential-shaped variable at all, so the check examined nothing.`,
        );
      }
      return pass(
        this.name,
        `${String(verdict.checked)} credential-shaped variable(s) all hold this run's gateway token`,
      );
    },
  },
  {
    name: 'gateway-is-programmatic',
    about:
      'the gateway connection reaches the engine whole — programmatically, or through the env variables the adapter declares',
    run(subject) {
      const gateway = gatewayFor(subject);
      const { baseUrl, token } = gateway.connection;
      const declared = Object.entries(subject.gatewayEnv?.(gateway.connection) ?? {});
      for (const [name, value] of declared) {
        const credential = isCredentialEnvName(name) && value === token;
        if (!credential && value !== baseUrl) {
          return fail(
            this.name,
            `the subject declares ${name} as a gateway variable, and it holds neither the gateway's base URL nor its token in a credential-shaped variable.`,
          );
        }
      }
      const result = subject.engine.compile(requestFor(subject, gateway));
      if (!result.ok) return fail(this.name, `the compile refused: ${result.reason}`);
      const compiled = subject.compiledEnv(result.compiled);
      const carried = Object.entries(compiled).filter(([, value]) => value === token);
      const hasBaseUrl = Object.values(compiled).includes(baseUrl);
      const dropped = declared.filter(([name, value]) => compiled[name] !== value);
      if (dropped.length > 0) {
        return fail(
          this.name,
          `the adapter declares that its engine reads the gateway from ${declared.map(([name]) => name).join(', ')} and the compiled environment does not carry ${dropped.map(([name]) => name).join(', ')} unchanged, so the run could not reach its model.`,
        );
      }
      if (carried.length === 0 && !hasBaseUrl) {
        return pass(
          this.name,
          'this engine reaches the gateway without putting it in the environment at all',
        );
      }
      if (carried.length === 0) {
        return fail(
          this.name,
          'the compiled environment names the gateway base URL but not its token, so the run would reach the gateway unauthenticated.',
        );
      }
      if (!hasBaseUrl) {
        return fail(
          this.name,
          `the compiled environment carries the gateway token in ${carried.map(([name]) => name).join(', ')} but not the gateway's base URL, so the engine would send the run token to its default endpoint.`,
        );
      }
      const how =
        declared.length > 0
          ? 'reads the gateway from the variables it declares'
          : 'translated the gateway connection into';
      return pass(this.name, `the adapter ${how}: ${carried.map(([name]) => name).join(', ')}`);
    },
  },
  {
    name: 'the-portable-permissions-decide-the-tool-policy',
    about:
      "each of §17 Step 4's four switches, turned off, removes what it governs from the adapter's compiled options",
    run(subject) {
      const gateway = gatewayFor(subject);
      const open = subject.engine.compile(requestFor(subject, gateway));
      if (!open.ok) return fail(this.name, `the unrestricted compile refused: ${open.reason}`);
      for (const permission of PERMISSION_KEYS) {
        // The baseline first, for the ADR-0015 reason the whole kit is written for: "the switch is
        // honoured" and "this adapter forbids that capability no matter what" are the same
        // observation unless the permissive request is checked too.
        if (!subject.permissionAllowed(open.compiled, permission)) {
          return fail(
            this.name,
            `with every permission granted the adapter's compiled options already forbid what ${permission} governs, so turning it off would prove nothing.`,
          );
        }
        const narrowed = subject.engine.compile(withPermissionOff(subject, gateway, permission));
        if (!narrowed.ok) {
          return fail(this.name, `the compile refused with ${permission} off: ${narrowed.reason}`);
        }
        if (subject.permissionAllowed(narrowed.compiled, permission)) {
          return fail(
            this.name,
            `the request set ${permission}: false and the adapter's compiled options still allow what it governs. A permission switch is the portable statement of what an agent may do; an engine that reads it and compiles nothing runs an agent wider than its author wrote.`,
          );
        }
      }
      return pass(
        this.name,
        `${String(PERMISSION_KEYS.length)} permission switches each allowed when granted and removed when not`,
      );
    },
  },
  {
    name: 'skills-are-placed-inside-the-declared-config-directory',
    about:
      'the adapter says where every granted skill file goes, and every path lands under its own configuration directory — or, for an engine that declares skills: false, it refuses them by name and places nothing',
    run(subject) {
      const gateway = gatewayFor(subject);
      const request = requestFor(subject, gateway, {
        resources: { files: [], skills: CONFORMANCE_SKILLS },
      });
      if (!subject.engine.capabilities.skills) {
        // ADR-0065 D4: skills are portable-with-refusal. An engine without them answers the
        // capability refusal a control plane branches on, and places nothing: a placement for an
        // engine that will not read it is tenant content written into the sandbox for no run.
        const refused = subject.engine.compile(request);
        if (refused.ok) {
          return fail(
            this.name,
            'the engine declares skills: false and compiled a request that grants skills. A requirement the engine cannot honour is refused, never silently dropped.',
          );
        }
        if (refused.code !== 'engine_capability_unsupported') {
          return fail(
            this.name,
            `the engine declares skills: false and refused a skill grant as ${refused.code} rather than engine_capability_unsupported.`,
          );
        }
        const unnamed = CONFORMANCE_SKILLS.filter((skill) => !refused.reason.includes(skill.name));
        if (unnamed.length > 0) {
          return fail(
            this.name,
            `the skills: false refusal does not name ${unnamed.map((skill) => skill.name).join(', ')}; a refusal names what it refuses.`,
          );
        }
        const placed = subject.engine.placeSkills(request);
        if (placed.length > 0) {
          return fail(
            this.name,
            `the engine declares skills: false and still placed ${String(placed.length)} skill file(s): ${placed.map((placement) => placement.path).join(', ')}.`,
          );
        }
        // The vacuity control: the refusal must be about the skills, so the same request without
        // them compiles.
        const open = subject.engine.compile(requestFor(subject, gateway));
        if (!open.ok) return fail(this.name, `the skill-free compile refused: ${open.reason}`);
        return pass(
          this.name,
          `skills: false declared; ${String(CONFORMANCE_SKILLS.length)} granted skills refused by name with engine_capability_unsupported and none placed`,
        );
      }
      const placements = subject.engine.placeSkills(request);
      const verdict = skillPlacementVerdict(
        placements,
        CONFORMANCE_SKILLS,
        subject.engine.protectedConfigDirectory,
      );
      if (!verdict.ok) return fail(this.name, `${verdict.refusal}: ${verdict.reason}`);
      const expected = CONFORMANCE_SKILLS.reduce((total, skill) => total + skill.files.length, 0);
      if (verdict.files !== expected) {
        return fail(
          this.name,
          `${String(expected)} skill files were granted and the adapter placed ${String(verdict.files)}. Every file of a granted skill is materialised, or the skill the agent was assigned is not the skill it gets.`,
        );
      }
      // A run with no skills must place none: an adapter that materialised a directory anyway
      // would be writing into the sandbox for a request that granted nothing.
      const none = subject.engine.placeSkills(requestFor(subject, gateway));
      if (none.length > 0) {
        return fail(
          this.name,
          `a request granting no skill still produced ${String(none.length)} placement(s): ${none.map((placement) => placement.path).join(', ')}.`,
        );
      }
      return pass(
        this.name,
        `${String(verdict.files)} files placed under ${JSON.stringify(subject.engine.protectedConfigDirectory)}: ${verdict.paths.join(', ')}`,
      );
    },
  },
  {
    name: 'connectors-are-honoured-or-refused-by-name',
    about:
      'an engine that declares mcp: true compiles a granted connector into its options (checked through connectorsCompiled when the subject declares it; otherwise only that it does not refuse); one that declares mcp: false refuses it with engine_capability_unsupported, naming it, and never emulates it',
    run(subject) {
      const gateway = gatewayFor(subject);
      const request = requestFor(subject, gateway, {
        portable: { ...PERMISSIVE_PORTABLE, mcpServers: CONFORMANCE_CONNECTORS },
      });
      const compiled = subject.engine.compile(request);
      const names = Object.keys(CONFORMANCE_CONNECTORS);
      if (subject.engine.capabilities.mcp) {
        if (!compiled.ok) {
          return fail(
            this.name,
            `the engine declares mcp: true and refused a remote connector: ${compiled.reason}`,
          );
        }
        if (subject.connectorsCompiled === undefined) {
          return pass(
            this.name,
            `mcp: true declared; ${names.join(', ')} not refused (the subject declares no connectorsCompiled, so the compiled options were not read)`,
          );
        }
        const compiledNames = subject.connectorsCompiled(compiled.compiled);
        const dropped = names.filter((name) => !compiledNames.includes(name));
        if (dropped.length > 0) {
          return fail(
            this.name,
            `the engine declares mcp: true and compiled a request granting ${dropped.join(', ')} without it. A requirement the engine cannot honour is refused, never silently dropped.`,
          );
        }
        return pass(this.name, `mcp: true declared; ${names.join(', ')} compiled`);
      }
      // ADR-0065 D4, as for skills: a connector is portable-with-refusal, and an engine without an
      // MCP client refuses it by name rather than bridging it or dropping it (ENG-08, #307).
      if (compiled.ok) {
        return fail(
          this.name,
          'the engine declares mcp: false and compiled a request that grants a connector. A requirement the engine cannot honour is refused, never silently dropped or emulated.',
        );
      }
      if (compiled.code !== 'engine_capability_unsupported') {
        return fail(
          this.name,
          `the engine declares mcp: false and refused a connector as ${compiled.code} rather than engine_capability_unsupported.`,
        );
      }
      const unnamed = names.filter((name) => !compiled.reason.includes(name));
      if (unnamed.length > 0) {
        return fail(
          this.name,
          `the mcp: false refusal does not name ${unnamed.join(', ')}; a refusal names what it refuses.`,
        );
      }
      const open = subject.engine.compile(requestFor(subject, gateway));
      if (!open.ok) return fail(this.name, `the connector-free compile refused: ${open.reason}`);
      return pass(
        this.name,
        `mcp: false declared; ${names.join(', ')} refused by name with engine_capability_unsupported (typed refusal)`,
      );
    },
  },
  {
    name: 'subagents-are-honoured-or-refused-by-name',
    about:
      'an engine that declares subagents: true compiles a subagent into its options (checked through subagentsCompiled, which such a subject must declare); one that declares subagents: false refuses it with engine_capability_unsupported, naming it, and never emulates it',
    run(subject) {
      const gateway = gatewayFor(subject);
      const request = requestFor(subject, gateway, {
        portable: { ...PERMISSIVE_PORTABLE, subagents: [CONFORMANCE_SUBAGENT] },
      });
      const compiled = subject.engine.compile(request);
      const { name } = CONFORMANCE_SUBAGENT;
      if (subject.engine.capabilities.subagents) {
        if (!compiled.ok) {
          return fail(
            this.name,
            `the engine declares subagents: true and refused a subagent: ${compiled.reason}`,
          );
        }
        if (subject.subagentsCompiled === undefined) {
          return fail(
            this.name,
            `the engine declares subagents: true but the subject declares no subagentsCompiled, so ${name} cannot be shown to be compiled`,
          );
        }
        if (!subject.subagentsCompiled(compiled.compiled).includes(name)) {
          return fail(
            this.name,
            `the engine declares subagents: true and compiled a request naming ${name} without it. A requirement the engine cannot honour is refused, never silently dropped.`,
          );
        }
        return pass(this.name, `subagents: true declared; ${name} compiled`);
      }
      if (compiled.ok) {
        return fail(
          this.name,
          'the engine declares subagents: false and compiled a request that names a subagent. A requirement the engine cannot honour is refused, never silently dropped or emulated.',
        );
      }
      if (compiled.code !== 'engine_capability_unsupported') {
        return fail(
          this.name,
          `the engine declares subagents: false and refused a subagent as ${compiled.code} rather than engine_capability_unsupported.`,
        );
      }
      if (!compiled.reason.includes(name)) {
        return fail(
          this.name,
          `the subagents: false refusal does not name ${name}; a refusal names what it refuses.`,
        );
      }
      const open = subject.engine.compile(requestFor(subject, gateway));
      if (!open.ok) return fail(this.name, `the subagent-free compile refused: ${open.reason}`);
      return pass(
        this.name,
        `subagents: false declared; ${name} refused by name with engine_capability_unsupported (typed refusal)`,
      );
    },
  },
  {
    name: 'a-read-only-grant-is-not-writable',
    about:
      "the adapter's compiled options refuse a write to every path a read-only grant covers, including through `..`",
    run(subject) {
      const gateway = gatewayFor(subject);
      const files = [
        { kind: 'directory' as const, path: 'docs', access: 'read' as const },
        { kind: 'file' as const, path: 'notes/plan.md', access: 'read' as const },
      ];
      const result = subject.engine.compile(
        requestFor(subject, gateway, { resources: { files, skills: [] } }),
      );
      if (!result.ok) return fail(this.name, `the compile refused: ${result.reason}`);
      const grants = normaliseGrants(files);
      if (!grants.ok) return fail(this.name, `the kit's own grants did not normalise`);
      const covered = [
        'docs',
        'docs/spec.md',
        'docs/./spec.md',
        'notes/../docs/spec.md',
        'docs/nested/../spec.md',
        'docs/deep/er/file.md',
        'notes/plan.md',
      ];
      for (const candidate of covered) {
        // The platform's own answer first, so a kit edit that listed an uncovered path here
        // fails loudly instead of asserting that the adapter refuses something nobody granted.
        if (writeGrantVerdict(candidate, grants.grants).ok) {
          return fail(
            this.name,
            `the kit lists ${JSON.stringify(candidate)} as covered and it is not.`,
          );
        }
        if (subject.writeAllowed(result.compiled, candidate)) {
          return fail(
            this.name,
            `${JSON.stringify(candidate)} normalises inside a read-only grant and the adapter's compiled options still allow the agent to write it.`,
          );
        }
      }
      const uncovered = ['scratch/output.md', 'docs-private/draft.md', 'notes/other.md'];
      for (const candidate of uncovered) {
        if (!subject.writeAllowed(result.compiled, candidate)) {
          return fail(
            this.name,
            `${JSON.stringify(candidate)} is outside every grant and the adapter's compiled options refuse a write to it. A grant narrows writes into what it covers; it does not forbid writing at all.`,
          );
        }
      }
      // The same request without the grants must leave a covered path writable, or the refusals
      // above could have come from an adapter that forbids every write.
      const open = subject.engine.compile(requestFor(subject, gateway));
      if (!open.ok) return fail(this.name, `the ungranted compile refused: ${open.reason}`);
      if (!subject.writeAllowed(open.compiled, 'docs/spec.md')) {
        return fail(
          this.name,
          'with no grant at all the adapter still refuses a write to docs/spec.md, so its refusals above say nothing about the grant.',
        );
      }
      return pass(
        this.name,
        `${String(covered.length)} spellings of grant-covered paths refused by the compiled options; ${String(uncovered.length)} uncovered paths and the ungranted request still writable`,
      );
    },
  },
  {
    name: 'the-protected-config-directory-is-declared-and-closed',
    about:
      'the adapter names its own config directory and refuses to compile a grant that normalises into it',
    run(subject) {
      const directory = subject.engine.protectedConfigDirectory;
      if (typeof directory !== 'string' || directory.length === 0) {
        return fail(
          this.name,
          'the engine declares no protected configuration directory, so the runner cannot know which directory a tenant file must not land in.',
        );
      }
      const gateway = gatewayFor(subject);
      const spellings = [
        `${directory}/settings.json`,
        `./${directory}/settings.json`,
        `x/../${directory}/settings.json`,
      ];
      for (const spelling of spellings) {
        for (const access of ['read', 'read-write'] as const) {
          const result = subject.engine.compile(
            requestFor(subject, gateway, {
              resources: { files: [{ kind: 'file', path: spelling, access }], skills: [] },
            }),
          );
          if (result.ok) {
            return fail(
              this.name,
              `a ${access} grant of ${JSON.stringify(spelling)} normalises into the declared protected directory ${JSON.stringify(directory)} and the adapter compiled it.`,
            );
          }
          if (result.code !== 'engine_policy_invalid') {
            return fail(
              this.name,
              `a grant of ${JSON.stringify(spelling)} was refused as ${result.code} rather than engine_policy_invalid.`,
            );
          }
        }
      }
      return pass(
        this.name,
        `declared ${JSON.stringify(directory)} and refused to compile ${String(spellings.length * 2)} grants into it`,
      );
    },
  },
  {
    name: 'the-session-id-is-reported-not-invented',
    about:
      'a run whose stream carries no session id rejects `engineSessionId` rather than guessing',
    async run(subject) {
      const gateway = gatewayFor(subject);
      const request = requestFor(subject, gateway);
      const connection = subject.engine.start(request);
      const frames = [];
      for await (const frame of connection.frames) frames.push(frame);
      const sessionFrames = frames.filter((frame) => frame.frame === 'agent.session');
      let settled: 'resolved' | 'rejected';
      let value = '';
      try {
        value = await connection.engineSessionId;
        settled = 'resolved';
      } catch {
        settled = 'rejected';
      }
      if (sessionFrames.length === 0) {
        return settled === 'rejected'
          ? pass(this.name, 'no session frame arrived and `engineSessionId` rejected')
          : fail(
              this.name,
              `no agent.session frame arrived and \`engineSessionId\` still resolved to ${JSON.stringify(value)}. An id nothing reported is an identity a later resume would be keyed by.`,
            );
      }
      if (settled === 'rejected') {
        return fail(
          this.name,
          'an agent.session frame arrived and `engineSessionId` nevertheless rejected.',
        );
      }
      if (value !== sessionFrames[0]?.engineSessionId) {
        return fail(
          this.name,
          `\`engineSessionId\` resolved to ${JSON.stringify(value)} but the first agent.session frame reported ${JSON.stringify(sessionFrames[0]?.engineSessionId)}.`,
        );
      }
      return pass(
        this.name,
        `reported ${JSON.stringify(value)} from the first agent.session frame`,
      );
    },
  },
  {
    name: 'every-frame-is-neutral-and-named-by-this-engine',
    about: "a connection yields only `agent.*` frames, each carrying this adapter's own id",
    async run(subject) {
      const connection = subject.engine.start(requestFor(subject, gatewayFor(subject)));
      let count = 0;
      for await (const frame of connection.frames) {
        count += 1;
        if (!frame.frame.startsWith('agent.')) {
          return fail(
            this.name,
            `frame ${String(count)} is named ${JSON.stringify(frame.frame)}, which is not in the neutral vocabulary.`,
          );
        }
        if (frame.engine !== subject.engine.id) {
          return fail(
            this.name,
            `frame ${String(count)} (${frame.frame}) carries engine ${JSON.stringify(frame.engine)}, not ${JSON.stringify(subject.engine.id)}.`,
          );
        }
      }
      if (count === 0) {
        return fail(
          this.name,
          'the run produced no frames at all, so this scenario proved nothing about the ones it would have produced.',
        );
      }
      return pass(
        this.name,
        `${String(count)} frames, all agent.* and all named ${subject.engine.id}`,
      );
    },
  },
  {
    name: 'durability-without-a-store-is-a-reasoned-no',
    about: 'a run with no session store answers `durable: false` with a sentence, never silence',
    async run(subject) {
      const connection = subject.engine.start(requestFor(subject, gatewayFor(subject)));
      for await (const frame of connection.frames) void frame;
      const verdict = connection.sessionDurability();
      if (verdict.durable) {
        return fail(
          this.name,
          `a run with no session store reported durable: true (${String(verdict.mirroredBatches)} batches). Without a store the transcript exists only inside the sandbox (spec §14.9).`,
        );
      }
      if (verdict.reason.trim().length === 0) {
        return fail(this.name, 'the verdict is `durable: false` with an empty reason.');
      }
      return pass(this.name, `refused with: ${verdict.reason}`);
    },
  },
  {
    name: 'durability-with-a-store-is-earned',
    about: 'a run whose mirror accepted every batch and reached a terminal frame is durable',
    async run(subject) {
      const store = createFakeSessionStore('accept');
      const connection = subject.engine.start(requestFor(subject, gatewayFor(subject)), {
        sessionStore: store,
      });
      for await (const frame of connection.frames) void frame;
      // The mirror's writes are asynchronous by construction; a verdict taken in the same tick
      // would be measuring the scheduler rather than the store.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      const verdict = connection.sessionDurability();
      if (!verdict.durable) {
        return fail(
          this.name,
          `a run whose store accepted ${String(store.appended().length)} batch(es) still reported durable: false — ${verdict.reason}`,
        );
      }
      return pass(this.name, `durable after ${String(verdict.mirroredBatches)} mirrored batch(es)`);
    },
  },
  {
    name: 'a-failed-store-write-makes-the-run-non-durable',
    about:
      'the platform rule of ENG-06: a store that could not write makes the verdict `false` for ' +
      'ANY engine, whatever the adapter itself observed',
    async run(subject) {
      // The store rejects, and the adapter may or may not have a way to notice — the Claude adapter
      // does (`append()` rejections and `system/mirror_error`), and an engine with no such signal
      // does not. `withStoreWriteFailures` is what makes the answer the same either way, which is
      // exactly the claim this scenario exists to hold for every adapter rather than for one.
      const store = createFakeSessionStore('reject');
      const connection = subject.engine.start(requestFor(subject, gatewayFor(subject)), {
        sessionStore: store,
      });
      // A store re-throws the write it could not make (`session-state.ts`: nothing there swallows
      // a failure — the engine's own policy decides whether a rejected write ends the run). So an
      // adapter that awaits its mirror is entitled to end the frame stream with that error, and
      // both answers are conformant. The claim under test is the *verdict*, so the stream's error
      // is drained rather than failing the scenario; it is not lost, because the store recorded the
      // same failure and the assertion below refuses a run in which it recorded none.
      let streamFailure: string | null = null;
      try {
        for await (const frame of connection.frames) void frame;
      } catch (error) {
        // Recorded rather than discarded: it is the sentence the failure arm below prints when the
        // store recorded nothing, which is the case where the run died for some other reason.
        streamFailure = error instanceof Error ? error.message : String(error);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      const failures = store.writeFailures();
      if (failures.length === 0) {
        return fail(
          this.name,
          'the rejecting store was never asked to write anything, so this scenario proved nothing ' +
            `about a run whose state could not be stored${streamFailure === null ? '' : `; the run stream ended with: ${streamFailure}`}.`,
        );
      }
      const verdict = withStoreWriteFailures(connection.sessionDurability(), failures);
      if (verdict.durable) {
        return fail(
          this.name,
          `a run whose store rejected ${String(failures.length)} write(s) reported durable: true. Spec §14.9: a session that survives only inside the sandbox is a release blocker.`,
        );
      }
      if (verdict.reason.trim().length === 0) {
        return fail(this.name, 'the verdict is `durable: false` with an empty reason.');
      }
      return pass(this.name, `refused after ${String(failures.length)} failed write(s)`);
    },
  },
  {
    name: 'interrupt-ends-the-stream',
    about: 'raising the cancellation signal stops the run rather than only being recorded',
    async run(subject) {
      const connection = subject.engine.start(requestFor(subject, gatewayFor(subject)));
      await connection.interrupt();
      let count = 0;
      for await (const frame of connection.frames) {
        void frame;
        count += 1;
        if (count > 64) {
          return fail(
            this.name,
            'the stream produced more than 64 frames after an interrupt; the signal was recorded but not acted on.',
          );
        }
      }
      return pass(
        this.name,
        `the stream ended after ${String(count)} frame(s) following the interrupt`,
      );
    },
  },
];

/** Run every scenario against one adapter. Never throws; a thrown scenario becomes a failure. */
export async function runEngineConformance<TCompiled>(
  subject: EngineConformanceSubject<TCompiled>,
): Promise<readonly ScenarioVerdict[]> {
  const verdicts: ScenarioVerdict[] = [];
  for (const scenario of CONFORMANCE_SCENARIOS) {
    try {
      verdicts.push(await scenario.run(subject));
    } catch (error) {
      verdicts.push(
        fail(
          scenario.name,
          `the scenario threw: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  return verdicts;
}

/**
 * Run the kit and throw unless every scenario passed.
 *
 * Deliberately not an `expect`: `packages/engine` has no test framework on its dependency list
 * (see this module's header). A throw is what every framework reads as a failure, and the message
 * carries each verdict so a reader does not have to re-run the kit to see which one broke.
 *
 * The count is asserted as well as the failures, for the ADR-0015 reason: "no scenario failed" is
 * also what a kit that ran nothing reports.
 */
export async function expectConformance<TCompiled>(
  subject: EngineConformanceSubject<TCompiled>,
): Promise<readonly ScenarioVerdict[]> {
  const verdicts = await runEngineConformance(subject);
  if (verdicts.length !== CONFORMANCE_SCENARIOS.length) {
    throw new Error(
      `the conformance kit returned ${String(verdicts.length)} verdicts for ${String(CONFORMANCE_SCENARIOS.length)} scenarios.`,
    );
  }
  const failures = verdicts.filter((verdict) => !verdict.pass);
  if (failures.length > 0) {
    throw new Error(
      `${String(failures.length)} of ${String(verdicts.length)} conformance scenarios failed for engine ${subject.engine.id}:\n` +
        failures
          .map((verdict) => `  ✗ ${verdict.scenario}: ${verdict.pass ? '' : verdict.reason}`)
          .join('\n'),
    );
  }
  return verdicts;
}
