import { promotePastGate } from '../../build-deploy-journey/journey.e2e.mjs';

/** @param {ReturnType<typeof import('../journey.e2e.mjs').createJourneyContext>} context */
export function createGateStep(context) {
  const { lane, s, controlPlaneLogs, bearer } = context;
  return {
    async gate() {
      if (s['pushRefused'] !== undefined) return s['pushRefused'];
      try {
        promotePastGate({
          created: s['created'],
          remote: bearer(),
          evidence: s['evidence'],
          refusal: true,
        });
      } catch (error) {
        // A run the control plane could not prepare is explained in its log, not in `aw eval`.
        throw lane.host === 'vercel' ? controlPlaneLogs(error) : error;
      }
    },
  };
}
