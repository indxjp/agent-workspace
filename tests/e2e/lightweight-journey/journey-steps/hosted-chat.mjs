import { terminalStatus } from '../../../generated-project/stack-api.mjs';

/** @param {ReturnType<typeof import('../journey.e2e.mjs').createJourneyContext>} context */
export function createHostedChatStep(context) {
  const { lane, secrets, s, check, ask, control, SURFACE, failedRunDetail, refusedRun } = context;
  return {
    async 'hosted-chat'() {
      if (s['pushRefused'] !== undefined) return s['pushRefused'];
      const page = await ask(`${control()}/p/s/${SURFACE}`);
      check(page.status === 200, `the hosted chat page answered ${String(page.status)}`);
      const session = await ask(`${control()}/p/s/${SURFACE}/sessions`, {
        method: 'POST',
        headers: { origin: control(), 'content-type': 'application/json' },
        body: '{}',
      });
      check(
        session.status === 201 && typeof session.json?.token === 'string',
        `a visitor session opened (${String(session.status)} ${session.text.slice(0, 200)})`,
      );
      secrets.push(session.json.token);
      check(
        typeof session.json.sessionId === 'string' && session.json.sessionId !== '',
        'the visitor session names its id',
      );
      const started = await ask(`${control()}/api/agents/${s['agentId']}/runs`, {
        method: 'POST',
        token: session.json.token,
        headers: { origin: control(), 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Say hello.', sessionId: session.json.sessionId }),
      });
      if (lane.refusal !== undefined) {
        return refusedRun(
          lane.refusal,
          started,
          () => s['client'].runFrames(started.json.run.id, { apiKey: session.json.token }),
          check,
        );
      }
      check(
        started.status === 202,
        `the visitor's run was accepted (${String(started.status)} ${started.text.slice(0, 200)})`,
      );
      const frames = await s['client'].runFrames(started.json.run.id, {
        apiKey: session.json.token,
      });
      const completed = terminalStatus(frames) === 'completed';
      check(
        completed,
        `the visitor run completed (${completed ? '' : await failedRunDetail(s['client'], started.json.run.id, secrets, session.json.token)})`,
      );
    },
  };
}
