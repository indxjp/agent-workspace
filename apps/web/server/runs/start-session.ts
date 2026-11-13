import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import { engineIsInstalled, engineNotInstalledMessage } from '../engines/images';
import { pinSessionEngine, sessionEngineMismatchMessage } from '../engines/session-engine';
import type { Usd } from '../newtypes';
import { log } from '../telemetry/logger';
import type { SessionRef } from './environment';
import type { RunStartContext, StartRunBody } from './start-input';
import { prepareRunStart } from './start-preparation';
import { refused, structuredOutputUnsupported, type RunStartRefused } from './start-refusal';
import type { CreateRunInput } from './store';

type PreparedRunSession =
  | RunStartRefused
  | {
      readonly kind: 'ready';
      readonly session: SessionRef;
      readonly engine: CreateRunInput['engine'];
      readonly spendCeilingUsd: Usd | null;
    };

export async function prepareSessionForRun(context: RunStartContext): Promise<PreparedRunSession> {
  let spendCeilingUsd: Usd | null = null;
  const { env, principal, agent, input } = context;
  // Reject a new run before opening a session; an existing session is checked after resolution.
  if (input.sessionId === null) {
    const preparation = await prepareNewSessionStart(context);
    if (preparation.kind === 'refused') return preparation;
    spendCeilingUsd = preparation.spendCeilingUsd;
  }

  const session = await env.openSession(
    principal,
    agent,
    input.sessionId,
    input.sessionId === null ? input.agentVersionId : undefined,
  );
  if (session === null) {
    return refused(
      409,
      'session_not_usable',
      'the requested session cannot run this agent; omit sessionId to start a new session (spec §19.5 rule 4).',
    );
  }

  const pin = pinSessionEngine({
    sessionEngine: session.engine,
    agentEngine: session.versionEngine ?? agent.engine,
  });
  if (pin.kind === 'mismatch') {
    return discardingOpened(
      context,
      session,
      refused(409, 'session_engine_mismatch', sessionEngineMismatchMessage(pin)),
    );
  }

  const engineRefusal = engineStartRefusal(pin.engine, input.outputSchema);
  if (engineRefusal !== null) return discardingOpened(context, session, engineRefusal);

  if (input.sessionId !== null) {
    const preparation = await prepareRunStart(context, session.id);
    if (preparation.kind === 'refused') return preparation;
    spendCeilingUsd = preparation.spendCeilingUsd;
  }

  return { kind: 'ready', session, engine: pin.engine, spendCeilingUsd };
}

/**
 * A refusal after `openSession` created a session leaves that session with no run in it, so it is
 * removed before the refusal is returned (as `startRunOnSession` does when the run insert fails). A
 * session the caller named is not this call's to remove.
 */
async function discardingOpened(
  { env, principal, input }: RunStartContext,
  session: SessionRef,
  refusal: RunStartRefused,
): Promise<RunStartRefused> {
  if (input.sessionId === null && env.discardSession !== undefined) {
    await env.discardSession(principal, session.id).catch((error: unknown) => {
      log.error('[runs] could not discard the session opened for a refused start', { error });
    });
  }
  return refusal;
}

function engineStartRefusal(
  engine: CreateRunInput['engine'],
  outputSchema: StartRunBody['outputSchema'],
): RunStartRefused | null {
  if (!engineIsInstalled(engine))
    return refused(422, 'engine_not_installed', engineNotInstalledMessage(engine));
  if (outputSchema !== undefined && !ENGINE_CATALOGUE[engine].structuredOutput)
    return structuredOutputUnsupported(engine);
  return null;
}

async function prepareNewSessionStart(context: RunStartContext) {
  const { agent, input } = context;
  const preparation = await prepareRunStart(context, null);
  if (preparation.kind === 'refused') return preparation;
  const fresh = pinSessionEngine({ sessionEngine: null, agentEngine: agent.engine });
  if (fresh.kind === 'pinned') {
    const refusal = engineStartRefusal(fresh.engine, input.outputSchema);
    if (refusal !== null) return refusal;
  }
  return preparation;
}
