import { assistantText, terminalStatus } from '../../../generated-project/stack-api.mjs';
import { chatNonce } from '../../build-deploy-journey/journey.e2e.mjs';

/** @param {ReturnType<typeof import('../journey.e2e.mjs').createJourneyContext>} context */
export function createChatApiStep(context) {
  const { lane, secrets, s, check, failedRunDetail, refusedRun } = context;
  return {
    async 'chat-api'() {
      if (s['pushRefused'] !== undefined) return s['pushRefused'];
      const nonce = chatNonce();
      const started = await s['client'].request(`/api/agents/${s['agentId']}/runs`, {
        method: 'POST',
        body: {
          prompt: `Look up order ${nonce} with your order tool and repeat the tool output exactly.`,
        },
      });
      if (lane.refusal !== undefined) {
        return refusedRun(
          lane.refusal,
          started,
          () => s['client'].runFrames(started.json.run.id),
          check,
        );
      }
      check(
        started.status === 202,
        `the run was accepted (${String(started.status)} ${started.text.slice(0, 200)})`,
      );
      const frames = await s['client'].runFrames(started.json.run.id);
      const completed = terminalStatus(frames) === 'completed';
      check(
        completed,
        `the run completed (${JSON.stringify(frames.slice(-3))}; ${completed ? '' : await failedRunDetail(s['client'], started.json.run.id, secrets)})`,
      );
      const reply = assistantText(frames);
      check(reply.includes(`order-data-${nonce}`), "the reply carries the code tool's data");
      check(reply.includes(`declared=${s['declared']}`), 'the tool read the secret it declared');
    },
  };
}
