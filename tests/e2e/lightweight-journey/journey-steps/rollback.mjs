import { readFileSync, writeFileSync } from 'node:fs';

import { promotePastGate } from '../../build-deploy-journey/journey.e2e.mjs';

/** @param {ReturnType<typeof import('../journey.e2e.mjs').createJourneyContext>} context */
export function createRollbackStep(context) {
  const { s, check, bearer } = context;
  return {
    async rollback() {
      if (s['pushRefused'] !== undefined) return s['pushRefused'];
      const { aw, agentPath, agentName } = s['created'];
      const remote = bearer();
      const versions = () => JSON.parse(aw(['versions', '--json'], remote));
      const production = () =>
        versions().pointers.find(
          (/** @type {{ environment: string }} */ p) => p.environment === 'production',
        )?.number;
      const first = production();
      const source = readFileSync(agentPath, 'utf8');
      const instructions = /^( {2}instructions: ')(.*)(',)$/mu;
      check(instructions.test(source), 'the agent file has one-line instructions to change');
      writeFileSync(agentPath, source.replace(instructions, '$1$2 Mention the order number.$3'));
      aw(['push', '--yes'], remote);
      promotePastGate({ created: s['created'], remote, evidence: s['evidence'], refusal: false });
      const second = production();
      check(
        second !== first,
        `a second version is in production (${String(first)} then ${String(second)})`,
      );
      aw(['rollback', agentName, '--yes'], remote);
      check(production() === first, 'aw rollback moved production back to the first version');
    },
  };
}
