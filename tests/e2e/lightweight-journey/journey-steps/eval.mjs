import { evaluateScripted } from '../../build-deploy-journey/journey.e2e.mjs';

import { OFFLINE_DECLARATION, OFFLINE_RUN_FILE } from '../../tool-sandbox.e2e.mjs';

/** @param {ReturnType<typeof import('../journey.e2e.mjs').createJourneyContext>} context */
export function createEvalStep(context) {
  const { lane, names, s } = context;
  return {
    async eval() {
      // Only the `aw deploy` lane has a project file environment; its url is the project's.
      const production =
        lane.deploy === 'aw'
          ? `  production:\n    target: vercel\n    url: https://${names.project}.vercel.app\n`
          : '';
      await evaluateScripted({
        created: s['created'],
        userEnv: s['userEnv'],
        evidence: s['evidence'],
        production,
        // Every lane runs the same tool, with no declared network: E2B runs a tool sandbox with
        // network none or open only (ADR-0132), and this journey asserts no egress.
        tool: { declaration: OFFLINE_DECLARATION, runFile: OFFLINE_RUN_FILE },
      });
    },
  };
}
