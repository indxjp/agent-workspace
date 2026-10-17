/**
 * `createScriptedEngine` — a real adapter with a fake engine behind it (ENG-04, #303).
 *
 * The runner and the control plane need to be tested against *an* engine, and until this unit
 * the only engine was the Claude Agent SDK — so every test of the runner's registry, its `/run`
 * refusals and its stream shape needed a third-party SDK installed and, in the honest cases, a
 * credential. That is the wrong dependency for a test about routing.
 *
 * This is the engine those tests use. It is deliberately **not** a mock: it implements
 * {@link AgentEngine} the same way a real adapter does — it parses its own policy arm, refuses
 * one it cannot read with a typed code, translates the gateway connection into its compiled
 * options, materialises nothing, and emits neutral frames through the port's own builders. What
 * it does not do is call a model. The script says what the run produced.
 *
 * It is also the second row of the conformance kit. A kit that only ever ran against the engine
 * it was written beside would encode that engine's habits; running the same scenarios against a
 * second, deliberately different implementation is what makes them scenarios about the *port*.
 */
import type { AgentPermissionKey, AgentPermissions } from '@indx-workspace/contracts/agents';
import type { EngineCapabilities } from '@indx-workspace/contracts/engines';

import {
  engineFrameBuilder,
  normaliseGrants,
  skillsUnderConfigDirectory,
  writeGrantVerdict,
  type AgentEngine,
  type EngineCompileResult,
  type EngineConnection,
  type EngineFrame,
  type EngineRunRequest,
  type EngineSkillFile,
  type EngineStartContext,
  type NormalisedGrant,
  type SessionDurabilityVerdict,
} from '../index.js';

/** The scripted engine's id. Not in `ENGINE_IDS`: it is a test double, never a catalogue entry. */
export const SCRIPTED_ENGINE_ID = 'scripted-test-engine';

export const SCRIPTED_ENGINE_CAPABILITIES: EngineCapabilities = {
  mcp: true,
  skills: true,
  subagents: false,
  resume: true,
  fork: true,
  interrupt: true,
  streamingText: false,
  reasoning: false,
  maxTurns: 'adapter',
  maxBudget: 'none',
  wireProtocols: ['anthropic-messages', 'openai-responses', 'openai-chat-completions'],
};

/**
 * The scripted engine's policy arm.
 *
 * Small on purpose, and *validated* rather than accepted: the `engine_policy_invalid` refusal is
 * one of the scenarios, and a double that accepted anything could not produce it.
 */
export type ScriptedEnginePolicy = {
  readonly kind: 'scripted';
  /** Written into the compiled options so a test can prove the policy reached the compile. */
  readonly label?: string | undefined;
};

/** What this engine compiles a request into. A plain object; nothing here is engine-native. */
export type ScriptedCompiledOptions = {
  readonly cwd: string;
  readonly prompt: string;
  readonly env: Readonly<Record<string, string>>;
  readonly label: string;
  readonly session: EngineRunRequest['session'];
  readonly skillDirectories: readonly string[];
  /**
   * The request's file grants, normalised. This double's whole tool grammar is "a write is
   * allowed exactly when `writeGrantVerdict` allows it", read back by
   * {@link scriptedOptionsAllowWrite}.
   */
  readonly grants: readonly NormalisedGrant[];
  /**
   * The capabilities this compile kept, one per §17 Step 4 switch.
   *
   * A deliberately *different* representation from the Claude adapter's, which compiles the same
   * decision into a list of its own tool names. That difference is the point of having a second row
   * in the conformance kit: a scenario that both engines pass is a scenario about the port, and one
   * only the Claude adapter can pass would be a scenario about Claude's tool vocabulary.
   */
  readonly allowed: AgentPermissions;
  /** The connector names this compile kept: every one the request grants, on an `mcp: true` double. */
  readonly connectors: readonly string[];
};

/**
 * Does a scripted compile let the agent write `path`? The conformance kit's `writeAllowed` for
 * this double: the platform's own `writeGrantVerdict` over the grants the compile kept, and the
 * `writeFiles` switch, which removes writing outright.
 */
export function scriptedOptionsAllowWrite(options: ScriptedCompiledOptions, path: string): boolean {
  if (!options.allowed.writeFiles) return false;
  return writeGrantVerdict(path, options.grants, SCRIPTED_PROTECTED_CONFIG_DIRECTORY).ok;
}

/**
 * Does a scripted compile still allow what one permission switch governs? The kit's
 * `permissionAllowed` for this double.
 */
export function scriptedOptionsAllowPermission(
  options: ScriptedCompiledOptions,
  permission: AgentPermissionKey,
): boolean {
  return options.allowed[permission];
}

/** The environment variables this engine translates its gateway connection into. */
export const SCRIPTED_GATEWAY_BASE_URL_ENV = 'SCRIPTED_ENGINE_BASE_URL';
export const SCRIPTED_GATEWAY_TOKEN_ENV = 'SCRIPTED_ENGINE_AUTH_TOKEN';

/** Where this engine reads skills from, relative to `cwd`. Its answer, not the platform's. */
export const SCRIPTED_PROTECTED_CONFIG_DIRECTORY = '.scripted-engine';

function parsePolicy(policy: unknown): ScriptedEnginePolicy | null {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) return null;
  const record = policy as Record<string, unknown>;
  if (record['kind'] !== 'scripted') return null;
  const label = record['label'];
  if (label !== undefined && typeof label !== 'string') return null;
  return { kind: 'scripted', label: label ?? undefined };
}

export type ScriptedEngineOptions = {
  /** The engine-native messages one run produces, in order. */
  readonly script?: readonly unknown[];
  /** Override the reported version, so a `/healthz` assertion has something to compare. */
  readonly version?: string;
  /** Narrow the declared capabilities, so a capability refusal can be reached. */
  readonly capabilities?: Partial<EngineCapabilities>;
};

/**
 * One scripted engine-native message becomes one neutral frame.
 *
 * The mapping is intentionally trivial — `{ kind: 'session' | 'message' | 'result' }` and
 * anything else is `agent.native`. A conformance scenario asserts that the frames carry this
 * engine's id and are drawn from the neutral vocabulary; it must not also be asserting that this
 * double has an interesting mapping, because then a failure would not say which of the two broke.
 */
function toFrames(message: unknown, engine: string): readonly EngineFrame[] {
  const frames = engineFrameBuilder(engine);
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return [frames.malformed('a scripted engine message must be an object', message)];
  }
  const record = message as Record<string, unknown>;
  const kind = record['kind'];
  if (kind === 'session' && typeof record['engineSessionId'] === 'string') {
    return [
      frames.session(
        {
          frame: 'agent.session',
          engineSessionId: record['engineSessionId'],
          model: typeof record['model'] === 'string' ? record['model'] : null,
        },
        message,
      ),
    ];
  }
  if (kind === 'message' && typeof record['text'] === 'string') {
    return [
      frames.message(
        {
          frame: 'agent.message',
          messageId: typeof record['id'] === 'string' ? record['id'] : null,
          role: record['role'] === 'user' ? 'user' : 'assistant',
          blocks: [{ type: 'text', text: record['text'] }],
        },
        message,
      ),
    ];
  }
  if (kind === 'result') {
    return [
      frames.result(
        {
          frame: 'agent.result',
          stopReason: record['stopReason'] === 'max_turns' ? 'max_turns' : 'end_turn',
          turns: typeof record['turns'] === 'number' ? record['turns'] : null,
          engineCostUsd: null,
        },
        message,
      ),
    ];
  }
  return [frames.native(typeof kind === 'string' ? kind : 'unknown', message)];
}

/**
 * Build the scripted engine.
 *
 * The default script is a session, a message and a result — the shortest run that exercises
 * every property the port promises about a connection: a session id is *reported*, frames are
 * neutral, and the stream reaches a terminal message.
 */
export function createScriptedEngine(
  options: ScriptedEngineOptions = {},
): AgentEngine<ScriptedCompiledOptions> {
  const script = options.script ?? [
    { kind: 'session', engineSessionId: 'scripted-session-1', model: 'scripted-model' },
    { kind: 'message', id: 'scripted-message-1', role: 'assistant', text: 'scripted answer' },
    { kind: 'result', stopReason: 'end_turn', turns: 1 },
  ];
  const capabilities: EngineCapabilities = {
    ...SCRIPTED_ENGINE_CAPABILITIES,
    ...options.capabilities,
  };

  const compile = (request: EngineRunRequest): EngineCompileResult<ScriptedCompiledOptions> => {
    const policy = parsePolicy(request.policy);
    if (policy === null) {
      return {
        ok: false,
        code: 'engine_policy_invalid',
        reason: `the scripted engine's policy arm must be { kind: 'scripted', label?: string }; got ${JSON.stringify(request.policy)}.`,
      };
    }
    if (request.session.mode === 'resume' && !capabilities.resume) {
      return {
        ok: false,
        code: 'engine_capability_unsupported',
        reason: 'this scripted engine declares resume: false, so it cannot continue a session.',
      };
    }
    if (request.session.mode === 'fork' && !capabilities.fork) {
      return {
        ok: false,
        code: 'engine_capability_unsupported',
        reason: 'this scripted engine declares fork: false, so it cannot branch a session.',
      };
    }
    if (request.gateway === null) {
      // This double has no legacy environment path to fall back on, and that is deliberate: a
      // new engine must not inherit the Claude CLI's two variables by accident, so the port's
      // `null` arm is a refusal here rather than a silent read of somebody else's credential.
      return {
        ok: false,
        code: 'engine_credential_refused',
        reason:
          'the scripted engine is handed its gateway connection programmatically and this request carries none.',
      };
    }
    const grants = normaliseGrants(request.resources.files, SCRIPTED_PROTECTED_CONFIG_DIRECTORY);
    if (!grants.ok) {
      return {
        ok: false,
        code: 'engine_policy_invalid',
        reason: `a file grant cannot be compiled: ${grants.reason}`,
      };
    }
    const connectors = Object.keys(request.portable.mcpServers);
    if (connectors.length > 0 && !capabilities.mcp) {
      return {
        ok: false,
        code: 'engine_capability_unsupported',
        reason: `this scripted engine declares mcp: false and the request assigns ${connectors.map((name) => JSON.stringify(name)).join(', ')}.`,
      };
    }
    if (request.resources.skills.length > 0 && !capabilities.skills) {
      return {
        ok: false,
        code: 'engine_capability_unsupported',
        reason: `this scripted engine declares skills: false and the request assigns ${request.resources.skills.map((skill) => JSON.stringify(skill.name)).join(', ')}.`,
      };
    }
    const subagents = request.portable.subagents ?? [];
    if (subagents.length > 0 && !capabilities.subagents) {
      return {
        ok: false,
        code: 'engine_capability_unsupported',
        reason: `this scripted engine declares subagents: false and the request names ${subagents.map((subagent) => JSON.stringify(subagent.name)).join(', ')}.`,
      };
    }
    return {
      ok: true,
      compiled: {
        cwd: request.cwd,
        prompt: request.prompt,
        // The gateway arrives programmatically and is translated here, which is the property the
        // `gateway-is-programmatic` scenario is about: the request's own `env` never carried it.
        env: {
          ...request.env,
          [SCRIPTED_GATEWAY_BASE_URL_ENV]: request.gateway.baseUrl,
          [SCRIPTED_GATEWAY_TOKEN_ENV]: request.gateway.token,
        },
        label: policy.label ?? '',
        session: request.session,
        skillDirectories: request.resources.skills.map(
          (skill) => `${request.cwd}/${SCRIPTED_PROTECTED_CONFIG_DIRECTORY}/skills/${skill.name}`,
        ),
        grants: grants.grants,
        // The portable permission switches, compiled. This double's grammar is the switches
        // themselves; a real adapter's is its engine's tool names.
        allowed: { ...request.portable.permissions },
        connectors,
      },
    };
  };

  return {
    id: SCRIPTED_ENGINE_ID,
    version: options.version ?? '0.0.0-scripted',
    capabilities,
    protectedConfigDirectory: SCRIPTED_PROTECTED_CONFIG_DIRECTORY,
    // An engine that declares `skills: false` reads no skill, so it places none; `compile` is where
    // it refuses the grant by name.
    placeSkills: (request: EngineRunRequest): readonly EngineSkillFile[] =>
      capabilities.skills
        ? skillsUnderConfigDirectory(request.resources.skills, SCRIPTED_PROTECTED_CONFIG_DIRECTORY)
        : [],
    compile,
    start(request: EngineRunRequest, context: EngineStartContext = {}): EngineConnection {
      const abortController = context.abortController ?? new AbortController();
      let reportedSessionId: ((id: string) => void) | null = null;
      let failSessionId: ((error: Error) => void) | null = null;
      const engineSessionId = new Promise<string>((resolve, reject) => {
        reportedSessionId = resolve;
        failSessionId = reject;
      });
      // A caller may legitimately never await this promise — an interrupted run's consumer often
      // does not — so its rejection is marked handled here rather than reaching the process.
      void engineSessionId.catch(() => undefined);

      let appended = 0;
      let inFlight = 0;
      let rejected: string | null = null;
      let exhausted = false;
      let sawResult = false;

      const frames = async function* (): AsyncGenerator<EngineFrame, void, void> {
        // A microtask tick, so this is genuinely async rather than a synchronous generator
        // wearing an `AsyncIterable` type — a real engine's frames arrive after awaits too, and
        // a consumer that only works against a synchronous one is a consumer that will break.
        await Promise.resolve();
        for (const message of script) {
          if (abortController.signal.aborted) break;
          if (context.sessionStore !== undefined) {
            inFlight += 1;
            void context.sessionStore
              .append({ projectKey: request.sessionId, sessionId: request.sessionId }, [
                { type: 'scripted', message },
              ])
              .then(
                () => {
                  appended += 1;
                  inFlight -= 1;
                },
                (error: unknown) => {
                  rejected = error instanceof Error ? error.message : String(error);
                  inFlight -= 1;
                },
              );
          }
          for (const frame of toFrames(message, SCRIPTED_ENGINE_ID)) {
            if (frame.frame === 'agent.session') {
              reportedSessionId?.(frame.engineSessionId);
              reportedSessionId = null;
            }
            if (frame.frame === 'agent.result') sawResult = true;
            yield frame;
          }
        }
        exhausted = true;
        if (reportedSessionId !== null) {
          failSessionId?.(
            new Error(
              'the scripted run ended without any frame carrying an engine session id, so this run cannot be resumed (spec §14.9).',
            ),
          );
          reportedSessionId = null;
        }
      };

      const sessionDurability = (): SessionDurabilityVerdict => {
        if (!exhausted) {
          return {
            durable: false,
            reason:
              'the frame stream has not been exhausted; durability is asserted about a completed run.',
          };
        }
        if (context.sessionStore === undefined) {
          return {
            durable: false,
            reason:
              'no session store was supplied, so this session exists only inside the sandbox (spec §14.9).',
          };
        }
        if (rejected !== null) {
          return { durable: false, reason: `a session store append rejected: ${rejected}` };
        }
        if (inFlight > 0) {
          return {
            durable: false,
            reason: `${String(inFlight)} session store append(s) were still in flight when the stream ended; their outcome is unknown.`,
          };
        }
        if (!sawResult) {
          return {
            durable: false,
            reason:
              'the stream ended without a terminal frame, so the transcript may be incomplete.',
          };
        }
        if (appended === 0) {
          return {
            durable: false,
            reason:
              'a session store was configured but received no append, so nothing was mirrored out of the sandbox.',
          };
        }
        return { durable: true, mirroredBatches: appended };
      };

      return {
        frames: frames(),
        engineSessionId,
        interrupt: () => {
          abortController.abort(new Error(`run ${request.runId} was interrupted`));
          return Promise.resolve();
        },
        sessionDurability,
      };
    },
  };
}
