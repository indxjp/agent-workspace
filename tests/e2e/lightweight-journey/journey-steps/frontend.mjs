/** @param {ReturnType<typeof import('../journey.e2e.mjs').createJourneyContext>} context */
export function createFrontendStep(context) {
  const { s, check, ask, control } = context;
  return {
    async frontend() {
      const page = await ask(s['frontendUrl']);
      check(page.status === 200, `the frontend answered ${String(page.status)}`);
      check(page.text.includes(control()), 'the frontend was built against the control plane url');
    },
  };
}
