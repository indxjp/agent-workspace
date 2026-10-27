/**
 * The start skeleton every adapter used to write for itself (#951).
 *
 * An adapter supplies what differs — `compile`, and a {@link EngineRunPlan} per run: its own events,
 * the mapper from those to neutral frames, which event ends the run, and its durability verdict.
 * {@link createEngineAdapter} supplies what does not: compile-or-throw, the abort controller, the
 * first `agent.session` frame, the cancelled-before-start branch, the `completed` flag, `interrupt`
 * and the engine session id promise.
 */
import type { EngineCapabilities } from '@indx-workspace/contracts/engines';

import { outputSchemaRefusal } from './compile-checks.js';
import { engineFrameBuilder, type EngineFrame } from './frames.js';
import type {
  AgentEngine,
  EngineCompileResult,
  EngineApprovalRequest,
  EngineConnection,
  EngineRunRequest,
  EngineSessionStore,
  EngineSkillFile,
  EngineFileSearchLink,
  EngineStartContext,
  SessionDurabilityVerdict,
} from './port.js';
import { skillsUnderConfigDirectory } from './skills.js';

/** Who knows the engine session id: the adapter, before the first event; or the stream, in its first `agent.session` frame. */
export type EngineRunIdentity =
  | {
      readonly kind: 'declared';
      readonly engineSessionId: string;
      readonly model: string | null;
      readonly raw: unknown;
    }
  | { readonly kind: 'reported' };

/** One run, as the adapter plans it after a successful compile. */
export type EngineRunPlan<TEvent> = {
  readonly identity: EngineRunIdentity;
  /** The engine's own events for this run. Called once. */
  events(): AsyncIterable<TEvent>;
  /** One engine event → neutral frames (the adapter's mapper). */
  map(event: TEvent): Iterable<EngineFrame>;
  /** True for the event after which the run counts as completed (durability input). */
  isTerminal(event: TEvent): boolean;
  /** The event mapped when the run was interrupted before it started; `null` when the engine watches the signal itself. */
  readonly cancelled: TEvent | null;
  /** The port's durability verdict, given whether a terminal event was seen. */
  durability(completed: boolean): SessionDurabilityVerdict;
  /** The call the run stopped on for want of approval (ADR-0145 D5); omit on an engine that cannot. */
  approvalRequest?(): EngineApprovalRequest | null;
};

export type EngineAdapterSpec<TCompiled, TEvent> = {
  readonly id: string;
  readonly version: string;
  readonly capabilities: EngineCapabilities;
  readonly protectedConfigDirectory: string;
  /** The catalogue's `structuredOutput`. Default `false`: a request carrying `outputSchema` is refused before `compile` runs. */
  readonly structuredOutput?: boolean;
  /** Default: `skillsUnderConfigDirectory(request.resources.skills, protectedConfigDirectory)` when `capabilities.skills`, else `[]`. */
  readonly placeSkills?: (request: EngineRunRequest) => readonly EngineSkillFile[];
  compile(request: EngineRunRequest): EngineCompileResult<TCompiled>;
  plan(
    compiled: TCompiled,
    request: EngineRunRequest,
    context: {
      readonly sessionStore: EngineSessionStore | undefined;
      readonly abortController: AbortController;
      readonly fileSearch: EngineFileSearchLink | undefined;
    },
  ): EngineRunPlan<TEvent>;
};

const NO_SESSION_ID =
  'the run ended without any frame carrying an engine session id, so this run has no session identity and cannot be resumed (spec §14.9).';

export function createEngineAdapter<TCompiled, TEvent>(
  spec: EngineAdapterSpec<TCompiled, TEvent>,
): AgentEngine<TCompiled> {
  const builder = engineFrameBuilder(spec.id);
  const compile = (request: EngineRunRequest): EngineCompileResult<TCompiled> =>
    outputSchemaRefusal(spec.id, spec.structuredOutput ?? false, request.outputSchema) ??
    spec.compile(request);

  return {
    id: spec.id,
    version: spec.version,
    capabilities: spec.capabilities,
    protectedConfigDirectory: spec.protectedConfigDirectory,

    placeSkills:
      spec.placeSkills ??
      ((request) =>
        spec.capabilities.skills
          ? skillsUnderConfigDirectory(request.resources.skills, spec.protectedConfigDirectory)
          : []),

    compile,

    start(request: EngineRunRequest, context: EngineStartContext = {}): EngineConnection {
      const compiled = compile(request);
      if (!compiled.ok) {
        throw new Error(
          `startRun: ${compiled.reason} Call compile() first and act on its refusal.`,
        );
      }
      const abortController = context.abortController ?? new AbortController();
      const plan = spec.plan(compiled.compiled, request, {
        sessionStore: context.sessionStore,
        abortController,
        fileSearch: context.fileSearch,
      });
      const { identity } = plan;
      let completed = false;

      let reportId: (id: string) => void = () => undefined;
      let failId: (error: Error) => void = () => undefined;
      const engineSessionId =
        identity.kind === 'declared'
          ? Promise.resolve(identity.engineSessionId)
          : new Promise<string>((resolve, reject) => {
              reportId = resolve;
              failId = reject;
            });
      // The caller may legitimately never await this — an interrupted run's consumer often does
      // not — so the rejection is marked handled here rather than reaching `unhandledRejection`.
      void engineSessionId.catch(() => undefined);
      let awaitingId = identity.kind === 'reported';

      function* observed(mapped: Iterable<EngineFrame>): Generator<EngineFrame, void, void> {
        for (const frame of mapped) {
          if (awaitingId && frame.frame === 'agent.session') {
            awaitingId = false;
            reportId(frame.engineSessionId);
          }
          yield frame;
        }
      }

      async function* frames(): AsyncGenerator<EngineFrame, void, void> {
        try {
          if (identity.kind === 'declared') {
            yield builder.session(
              {
                frame: 'agent.session',
                engineSessionId: identity.engineSessionId,
                model: identity.model,
              },
              identity.raw,
            );
          }
          if (plan.cancelled !== null && abortController.signal.aborted) {
            completed = true;
            yield* observed(plan.map(plan.cancelled));
          } else {
            for await (const event of plan.events()) {
              yield* observed(plan.map(event));
              if (plan.isTerminal(event)) completed = true;
            }
          }
        } catch (error) {
          if (awaitingId) {
            awaitingId = false;
            failId(
              new Error(
                `the run stream failed before any frame carried an engine session id: ${error instanceof Error ? error.message : `non-Error thrown: ${String(error)}`}`,
              ),
            );
          }
          throw error;
        } finally {
          // Also reached when the consumer abandons the stream (`break`, `frames.return()`).
          if (awaitingId) {
            awaitingId = false;
            failId(new Error(NO_SESSION_ID));
          }
        }
      }

      return {
        frames: frames(),
        engineSessionId,
        interrupt: () => {
          abortController.abort(new Error(`run ${request.runId} was interrupted`));
          return Promise.resolve();
        },
        sessionDurability: (): SessionDurabilityVerdict => plan.durability(completed),
        ...(plan.approvalRequest === undefined
          ? {}
          : { approvalRequest: () => plan.approvalRequest?.() ?? null }),
      };
    },
  };
}
