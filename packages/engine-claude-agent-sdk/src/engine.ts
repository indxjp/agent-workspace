/**
 * The Claude Agent SDK, behind the engine port (ENG-04, #303).
 *
 * This is the file that makes `apps/runner` stop knowing what Claude is. Everything Claude-shaped
 * that used to be reachable from the runner — the compile step, the `query()` call, the event
 * classification, the `agent.*` mapping, the durability verdict — is behind
 * the adapter {@link createClaudeAgentSdkEngine} builds, and the runner reaches it through
 * `@agent-workspace/engine`'s {@link AgentEngine} and nothing else.
 *
 * ## What `compile` translates, and what it refuses
 *
 * `compile` is `./compile.ts`'s `compileRunRequest`, unchanged, with one thing added around it:
 * the port hands requests whose `policy` arm is `unknown`, so this adapter parses that arm before
 * compiling and answers {@link EngineRefusalCode} `engine_policy_invalid` when it cannot. That
 * refusal is a value, not a throw, because the runner turns it into a `run-error` frame with a
 * stable code and a thrown `Error` carries only a sentence.
 *
 * ## Why `protectedConfigDirectory` is a field and not a constant somewhere else
 *
 * `.claude` used to be hard-coded in three places — the runner's resource materialisation, the
 * control plane's `sandboxFor`, and `packages/runtime`'s environment builder — each of them
 * knowing the name of a directory belonging to an engine none of them imports. The rule they
 * were all expressing is *"a tenant file must not land in the engine's own configuration
 * directory"*, and only the engine knows which directory that is. So the adapter declares it and
 * the runner asks.
 */
import {
  toAgentFrames,
  type ClassifiedSdkEvent,
  type RunRequest,
} from '@agent-workspace/run-protocol';
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import {
  approvalsRefusal,
  capFrameRaw,
  createEngineAdapter,
  credentialRejectedError,
  forkRefusal,
  parsePolicyArm,
  refuse,
  sandboxRefusal,
  skillScriptSetup,
  skillsUnderConfigDirectory,
  type AgentEngine,
  type EngineCompileResult,
  type EngineRunRequest,
  type EngineSessionStore,
} from '@agent-workspace/engine';

import { startRun, structuredOutputFailure, type TranscriptMirror } from './boundary.js';
import { compileRunRequest, SubagentToolRemovedError } from './compile.js';
import type { CompiledClaudeRun } from './options.js';
import { ClaudeRunPolicy } from './policy.js';
import { CLAUDE_PROTECTED_CONFIG_DIRECTORY } from './scope.js';
import { fileSearchSetup } from './file-search.js';
import { CLAUDE_SKILL_SCRIPT_SERVER } from './skill-script.js';
import { claudeFileGrantDenials } from './tools.js';

/** The engine id this adapter answers to. The same string as `ENGINE_IDS[0]`. */
export const CLAUDE_AGENT_SDK_ENGINE_ID = 'claude-agent-sdk';

/**
 * The version of `@anthropic-ai/claude-agent-sdk` this adapter is built against.
 *
 * Restated rather than read from the manifest at run time: this package is bundled into a
 * runtime image where `package.json` is not guaranteed to be readable beside the built
 * JavaScript, and a version that answers `undefined` in production is a `/healthz` that reports
 * a runtime nobody can identify. `engine.test.ts` holds it to this package's own manifest, which
 * is the same "watched by a replay, not by a comment" rule
 * `docs/adr/W2-CP-07-a-restatement-across-a-package-boundary-is-watched-by-a-replay-not-a-comment.md`
 * states.
 */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.310';

/**
 * The Claude Agent SDK's capabilities, as R-01 measured them.
 *
 * `fork` and `streamingText` are `false` because neither is reachable through this platform
 * today — the capability set states what a deployment can be *asked* for, not what the
 * third-party SDK could be configured to do. `maxTurns` and `maxBudget` are `native`: the SDK
 * enforces both itself, so no adapter has to count. `wireProtocols` is Anthropic Messages alone,
 * which is also the only ingress the gateway serves a Claude run over.
 *
 * The values are the engine catalogue's (ADR-0136), which the control plane's registry reads too,
 * because the control plane may not import an engine adapter (`dependency-cruiser.config.mjs`).
 */
export const CLAUDE_AGENT_SDK_CAPABILITIES = ENGINE_CATALOGUE['claude-agent-sdk'].capabilities;

/**
 * Rebuild the `RunRequest` the compile step and `query()` take, from the port's neutral request.
 *
 * The translation is mechanical and is the seam ENG-04 deliberately left visible: the private
 * `/run` contract speaks `RunRequest`, the port speaks {@link EngineRunRequest}, and one of them
 * has to be built from the other. Doing it here — inside the adapter, in one named function — is
 * what keeps the runner from doing it in five places.
 *
 * `session` keeps the SDK's three legal combinations (R-01 §6), derived from the port's neutral
 * selector: a `fork` needs both a resume target and a fresh id, and the platform's own session id
 * is the fresh one.
 */
function toRunRequest(request: EngineRunRequest, policy: ClaudeRunPolicy): RunRequest {
  const session: RunRequest['session'] =
    request.session.mode === 'resume'
      ? { kind: 'resume', resume: request.session.engineSessionId }
      : request.session.mode === 'fork'
        ? {
            kind: 'fork',
            resume: request.session.engineSessionId,
            sessionId: request.sessionId,
          }
        : { kind: 'fresh', sessionId: request.sessionId };
  return {
    runId: request.runId,
    sessionId: request.sessionId,
    cwd: request.cwd,
    prompt: request.prompt,
    engine: request.engine,
    projectKey: request.projectKey,
    // The port's portable core is the contract's, structurally. It is re-validated by
    // `compileRunRequest`'s own `RunRequest.parse` — the port types `mcpServers` values as
    // `unknown`, because MCP's schema is not the port's to carry, and this is where the values
    // that are about to reach an SDK get checked against it.
    portable: request.portable as RunRequest['portable'],
    policy,
    session,
    env: { ...request.env },
    // `null` is the pre-ENG-04 body whose credential is still `ANTHROPIC_BASE_URL` /
    // `ANTHROPIC_AUTH_TOKEN` in `env`. The Claude adapter is the one engine allowed to read
    // those, because they are its own CLI's variables; `compileRunRequest` then checks the
    // assembled environment against whichever token it found. See `packages/engine`'s
    // `EngineRunRequest.gateway`.
    ...(request.gateway === null ? {} : { gateway: { ...request.gateway } }),
    // `resources` is deliberately not reconstructed. The port hands an adapter file grants
    // *without* their bytes, because the runner is what writes them to disk (they are
    // engine-neutral bytes going to an engine-specific place — see
    // `AgentEngine.protectedConfigDirectory`). What the compile needs from a grant is its
    // *denials*, and those are folded into the policy arm by {@link withFileGrants} before this
    // function is called, so fabricating an entry with empty content here would put a lie in the
    // request to satisfy a field nothing reads.
  };
}

/**
 * Fold the request's file grants into the Claude policy arm's `fileGrantDeny` (ENG-04 T3).
 *
 * This is the adapter half of a read-only grant — the runner's read-only filesystem modes are the
 * other, independent half. `./tools.ts`'s `claudeFileGrantDenials` normalises every grant first, so
 * a grant that escapes the workspace, is absolute, or names this engine's own
 * {@link CLAUDE_PROTECTED_CONFIG_DIRECTORY} refuses the run rather than compiling a rule over a
 * path the rule does not mean.
 *
 * The control plane's own `applyFileGrantPolicy` puts the same rules on the wire as a guard, and the
 * compile de-duplicates the two in order — so a request the control plane already narrowed compiles
 * to the same options, and a request it did not (a second control plane, a replayed body, the
 * conformance kit) is narrowed here anyway.
 */
export function withFileGrants(
  request: EngineRunRequest,
  policy: ClaudeRunPolicy,
):
  | { readonly ok: true; readonly policy: ClaudeRunPolicy }
  | { readonly ok: false; readonly reason: string } {
  const derived = claudeFileGrantDenials(
    request.cwd,
    request.resources.files,
    CLAUDE_PROTECTED_CONFIG_DIRECTORY,
  );
  if (!derived.ok) return derived;
  if (derived.deny.length === 0) return { ok: true, policy };
  return {
    ok: true,
    policy: {
      ...policy,
      fileGrantDeny: [...new Set([...policy.fileGrantDeny, ...derived.deny])],
    },
  };
}

/**
 * The two variables the Claude Agent SDK's bundled CLI reads its gateway connection from.
 *
 * On today's (pre-v2) private contract, compose writes these into `env` itself
 * (`apps/web/server/compose/run-request.ts`) and this adapter passes them through; it does not
 * derive them from `gateway`. This function states the pair once, for the conformance kit's
 * `gatewayEnv` — so the kit's requests carry the credential a real Claude run carries — and for
 * the unit that moves the translation into `compileRunRequest` when compose stops writing them.
 */
export function claudeGatewayEnv(connection: {
  readonly baseUrl: string;
  readonly token: string;
}): Readonly<Record<string, string>> {
  return { ANTHROPIC_BASE_URL: connection.baseUrl, ANTHROPIC_AUTH_TOKEN: connection.token };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : `non-Error thrown: ${String(error)}`;
}

/**
 * The status of an `api_retry` the bundled CLI emits after a `401`/`403`, or `null` for any other
 * event (issue #661). The CLI retries every failed model call for minutes; a rejected key will not
 * pass, so the run stops at the first such retry instead. `429`, `5xx` and a retry with no status
 * keep retrying. Only the status is read — no key and no provider text reaches the failure.
 */
function rejectedKeyStatus(event: ClassifiedSdkEvent): 401 | 403 | null {
  if (event.kind !== 'system' || event.subtype !== 'api_retry') return null;
  const status = event.event['error_status'];
  return status === 401 || status === 403 ? status : null;
}

/** How long the one probe that tells the gateway's `401` from the provider's may take. */
const GATEWAY_PROBE_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The gateway's own refusal code (`token_*`, `packages/gateway/src/auth.ts`) in a `401`/`403`
 * answer, or `null` when the answer is not one: the token was good. */
async function gatewayTokenCode(answer: Response): Promise<string | null> {
  if (answer.status !== 401 && answer.status !== 403) {
    await answer.body?.cancel();
    return null;
  }
  const body: unknown = await answer.json().catch(() => null);
  const error = isRecord(body) ? body['error'] : undefined;
  const code = isRecord(error) ? error['code'] : undefined;
  return typeof code === 'string' && /^token_[a-z_]+$/u.test(code) ? code : null;
}

/**
 * What a run fails with after an auth retry (issue #661). The `api_retry` event carries only the
 * status, so it cannot say whether the provider rejected the key or the gateway refused the run's
 * own token. One `GET /v1/models` to the gateway with the run token decides it: a `token_*`
 * refusal is the gateway's, and the run fails uncoded so nobody is told to replace a good key;
 * any other answer means the token is good, so the `401`/`403` was the provider's. A probe that
 * fails claims nothing. The token goes only into the request header — never into a message.
 */
async function rejectionFailure(
  status: 401 | 403,
  gateway: { readonly baseUrl: string; readonly token: string } | null,
  probe: typeof fetch,
): Promise<Error> {
  const keyRejected = credentialRejectedError(status);
  // `compile` refuses a request without a gateway, so this is only the type's other arm.
  if (gateway === null) return keyRejected;
  let code: string | null;
  try {
    const answer = await probe(`${gateway.baseUrl.replace(/\/+$/u, '')}/v1/models`, {
      headers: { authorization: `Bearer ${gateway.token}` },
      signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS),
    });
    code = await gatewayTokenCode(answer);
  } catch {
    return new Error(
      `a model call was refused (HTTP ${String(status)}) and the model gateway could not be asked whether the run's token or the provider's key was refused.`,
    );
  }
  return code === null
    ? keyRejected
    : new Error(`the model gateway refused this run's token (HTTP ${String(status)} ${code}).`);
}

/**
 * Adapt an {@link EngineSessionStore} to the boundary's {@link TranscriptMirror}.
 *
 * The two are the same shape with different names, which is what a port looks like when the
 * thing behind it was written first: `TranscriptMirror` is the SDK's `SessionStore` restated in
 * platform types (see `./boundary.ts`), and `EngineSessionStore` is the port's neutral version
 * of the same idea. This function is where they meet, and it is three lines rather than a cast
 * because the SDK's optional methods are not on the port's interface and must be absent rather
 * than `undefined`.
 */
function toTranscriptMirror(store: EngineSessionStore): TranscriptMirror {
  const listSessions = store.listSessions?.bind(store);
  const listSessionSummaries = store.listSessionSummaries?.bind(store);
  const remove = store.delete?.bind(store);
  const listSubkeys = store.listSubkeys?.bind(store);
  return {
    append: (key, entries) => store.append(key, entries),
    load: async (key) => {
      const loaded = await store.load(key);
      return loaded === null ? null : [...loaded];
    },
    // Each optional member is forwarded when the store has one and **absent** when it does not.
    // Not `undefined`: `boundary.ts`'s `SameShapeAs<TranscriptMirror, SessionStore>` check is
    // about a store an engine will accept, and a present-but-undefined method is a different
    // thing from an absent one to a caller that tests `store.delete !== undefined`.
    ...(listSessions === undefined
      ? {}
      : { listSessions: async (projectKey: string) => [...(await listSessions(projectKey))] }),
    ...(listSessionSummaries === undefined
      ? {}
      : {
          listSessionSummaries: async (projectKey: string) => [
            ...(await listSessionSummaries(projectKey)),
          ],
        }),
    ...(remove === undefined ? {} : { delete: remove }),
    ...(listSubkeys === undefined
      ? {}
      : {
          listSubkeys: async (key: { projectKey: string; sessionId: string }) => [
            ...(await listSubkeys(key)),
          ],
        }),
  };
}

/**
 * How this adapter starts a run.
 *
 * A parameter with the real `startRun` as its default, for exactly one reason and it is the
 * reason the runner's own `startAgent` is a parameter: the conformance kit
 * (`@agent-workspace/engine/testing`) has to drive **this adapter** — its policy parse, its
 * gateway translation, its frame mapping, its durability verdict — through a run, and a real
 * run spawns the SDK's bundled CLI and needs an Anthropic credential. Substituting the one
 * function that calls `query()` lets the kit replay recorded SDK messages against everything
 * else, which is the whole of the adapter except the two lines no test can run anyway.
 *
 * It is one function argument, not an injection framework (§39 rule 4), and production has
 * exactly one caller which passes nothing.
 */
export type ClaudeRunStarter = typeof startRun;

/**
 * `compile`: the checks in the order the port documents (policy arm, fork, file grants, sandbox
 * environment), then `./compile.ts`'s `compileRunRequest`. A refusal is a value, never a throw.
 */
function compileClaude(request: EngineRunRequest): EngineCompileResult<CompiledClaudeRun> {
  const parsed = parsePolicyArm(
    CLAUDE_AGENT_SDK_ENGINE_ID,
    ClaudeRunPolicy,
    '{ tools, fileGrantDeny?, requireApproval?, handoff?, approvedToolCalls? }',
    request.policy,
  );
  if (!parsed.ok) return parsed;
  const forked = forkRefusal(
    CLAUDE_AGENT_SDK_ENGINE_ID,
    CLAUDE_AGENT_SDK_CAPABILITIES,
    request.session,
  );
  if (forked !== null) return forked;
  const unapproved = approvalsRefusal(
    CLAUDE_AGENT_SDK_ENGINE_ID,
    ENGINE_CATALOGUE['claude-agent-sdk'].approvals,
    parsed.policy.requireApproval,
  );
  if (unapproved !== null) return unapproved;
  const granted = withFileGrants(request, parsed.policy);
  if (!granted.ok) return refuse('engine_policy_invalid', granted.reason);
  // Spec A.11, decided from the typed verdict before anything is compiled — never by reading an
  // error's message. The check is over the environment the request hands this engine;
  // `compileRunRequest` repeats it over the assembled environment (with its four derived, never
  // credential-shaped, entries) as the second, independent check.
  //
  // The check needs the run token from the gateway connection: without one, the only candidate is
  // the environment's own `ANTHROPIC_AUTH_TOKEN`, which a provider key there would match by
  // definition.
  if (request.gateway === null) {
    return refuse(
      'engine_credential_refused',
      `${CLAUDE_AGENT_SDK_ENGINE_ID} reaches its model only through the gateway connection on the request, and this request carries none.`,
    );
  }
  const sandbox = sandboxRefusal(request.env, request.gateway.token);
  if (sandbox !== null) return sandbox;
  if (
    CLAUDE_SKILL_SCRIPT_SERVER in request.portable.mcpServers &&
    (skillScriptSetup(request, CLAUDE_PROTECTED_CONFIG_DIRECTORY) !== null || parsed.policy.handoff)
  ) {
    return refuse(
      'engine_policy_invalid',
      `a connector may not be named ${JSON.stringify(CLAUDE_SKILL_SCRIPT_SERVER)}: that server carries run_skill_script and handoff_to_person.`,
    );
  }
  try {
    const compiled = compileRunRequest(toRunRequest(request, granted.policy));
    return {
      ok: true,
      compiled:
        request.outputSchema === undefined
          ? compiled
          : { ...compiled, outputFormat: { type: 'json_schema', schema: request.outputSchema } },
    };
  } catch (error) {
    if (error instanceof SubagentToolRemovedError) {
      return refuse('engine_capability_unsupported', error.message);
    }
    // Everything `compileRunRequest` can still throw here is a request this engine cannot read — a
    // `ZodError` from its parse — so the code is not chosen by what the message says. A credential
    // in the environment was refused above, from the typed verdict.
    return refuse('engine_policy_invalid', describeError(error));
  }
}

/**
 * Build the adapter — the package root's only export (W3-8). With no arguments it runs the real SDK.
 * `probe` is the `fetch` that asks the gateway who refused an auth retry (issue #661).
 */
export function createClaudeAgentSdkEngine(
  runStarter: ClaudeRunStarter = startRun,
  probe: typeof fetch = fetch,
): AgentEngine<CompiledClaudeRun> {
  return createEngineAdapter<CompiledClaudeRun, ClassifiedSdkEvent>({
    id: CLAUDE_AGENT_SDK_ENGINE_ID,
    version: CLAUDE_AGENT_SDK_VERSION,
    capabilities: CLAUDE_AGENT_SDK_CAPABILITIES,
    structuredOutput: ENGINE_CATALOGUE['claude-agent-sdk'].structuredOutput,
    protectedConfigDirectory: CLAUDE_PROTECTED_CONFIG_DIRECTORY,

    // Spelled out rather than taken from the kit's default: `${CLAUDE_CONFIG_DIR}/skills/<name>/`
    // (R-01 §8, spec §7) is this engine's answer, and the Lean specification cites this member.
    placeSkills: (request) =>
      skillsUnderConfigDirectory(request.resources.skills, CLAUDE_PROTECTED_CONFIG_DIRECTORY),

    compile: compileClaude,

    plan: (compiled, request, { sessionStore, abortController, fileSearch: link }) => {
      // The kit calls `plan` only after `compile` answered `ok`, with that result for this request.
      // `ClaudeRun.abort` is `abortController.abort`, so the kit's controller is the run's.
      const skillScript = skillScriptSetup(request, CLAUDE_PROTECTED_CONFIG_DIRECTORY);
      const fileSearch = fileSearchSetup(request, link);
      const run = runStarter(
        {
          runId: request.runId,
          projectKey: request.projectKey,
          prompt: request.prompt,
          options: compiled,
          approval: compiled.approval,
          handoff: compiled.handoff,
        },
        {
          abortController,
          ...(skillScript === null ? {} : { skillScript }),
          ...(fileSearch === null ? {} : { fileSearch }),
          ...(sessionStore === undefined ? {} : { sessionStore: toTranscriptMirror(sessionStore) }),
        },
      );

      return {
        identity: { kind: 'reported' },
        events: async function* () {
          // A failure this loop raises itself is a real failure even with a request recorded.
          let raised: unknown = undefined;
          try {
            for await (const event of run.events) {
              // The deny-and-interrupt that stops a run for approval ends the SDK's turn with its
              // own `result`. That is the stop working, not a model failure, so it is not reported.
              if (
                run.approvalRequest() !== null &&
                (event.kind === 'result' || event.kind === 'result-unknown')
              ) {
                continue;
              }
              // The frames of a rejecting event are emitted before the run fails.
              yield event;
              const rejected = rejectedKeyStatus(event);
              if (rejected !== null) {
                const failure = await rejectionFailure(rejected, request.gateway, probe);
                run.abort(failure);
                raised = failure;
                throw failure;
              }
              const unsatisfied = structuredOutputFailure(event);
              if (unsatisfied !== null) {
                run.abort(unsatisfied);
                raised = unsatisfied;
                throw unsatisfied;
              }
            }
          } catch (error) {
            // The SDK may also end an interrupted run by throwing; with a request recorded, that
            // is the stop, not a failure.
            if (error === raised || run.approvalRequest() === null) throw error;
          }
        },
        // `toAgentFrames` is `packages/core`'s, and deliberately still is: the control plane runs
        // the same mapping over `run_events` rows recorded before ENG-03 to upgrade them
        // (`apps/web/server/runs/agent-frames.ts`), and `apps/web` may not import an engine
        // adapter. It is built on the port's `engineFrameBuilder` (ADR-0070 D4, amended by #958)
        // and finishes its move with ADR-0070's Deviation 2.
        map: (event) => {
          const frames = toAgentFrames(event, CLAUDE_AGENT_SDK_ENGINE_ID);
          const handoff = run.handoff();
          // The SDK's `result` ends the turn the tool asked the model to end, so the handoff frame
          // follows it and is the run's last agent frame (ADR-0145 D4).
          if (handoff === null || (event.kind !== 'result' && event.kind !== 'result-unknown')) {
            return frames;
          }
          return [
            ...frames,
            {
              frame: 'agent.handoff',
              engine: CLAUDE_AGENT_SDK_ENGINE_ID,
              raw: capFrameRaw(event.event),
              reason: handoff.reason,
            },
          ];
        },
        // Claude's verdict reads the run's own state, not a terminal event.
        isTerminal: () => false,
        // The SDK watches the abort signal itself.
        cancelled: null,
        durability: () => run.sessionDurability(),
        approvalRequest: () => run.approvalRequest(),
      };
    },
  });
}
