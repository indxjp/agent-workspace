import { chatNonce } from '../../build-deploy-journey/journey.e2e.mjs';

/** @param {ReturnType<typeof import('../journey.e2e.mjs').createJourneyContext>} context */
export function createWidgetStep(context) {
  const { secrets, s, check, ask, control, SURFACE, failedRunDetail, frontendTurn } = context;
  return {
    async widget() {
      if (s['pushRefused'] !== undefined) return s['pushRefused'];
      const script = await ask(`${control()}/p/s/${SURFACE}/widget.js`);
      check(
        script.status === 200 && script.text.length > 0,
        `widget.js answered ${String(script.status)}`,
      );
      const session = await ask(`${control()}/p/s/${SURFACE}/sessions`, {
        method: 'POST',
        headers: { origin: s['frontendUrl'], 'content-type': 'application/json' },
        body: '{}',
      });
      check(
        session.status === 201,
        `a session opened from the frontend origin (${String(session.status)} ${session.text.slice(0, 200)})`,
      );
      const refused = await ask(`${control()}/p/s/${SURFACE}/sessions`, {
        method: 'POST',
        headers: { origin: 'https://not-allowed.example', 'content-type': 'application/json' },
        body: '{}',
      });
      check(
        refused.status >= 400,
        `a session from another origin was refused (${String(refused.status)})`,
      );

      // The lanes with no agent returned above, so a turn is expected to run here.
      const visitor = { apiKey: session.json.token };
      await frontendTurn({
        control: control(),
        origin: s['frontendUrl'],
        nonce: chatNonce(),
        session: session.json,
        ask,
        framesOf: (id) => s['client'].runFrames(id, visitor),
        detailOf: (id) => failedRunDetail(s['client'], id, secrets, visitor.apiKey),
        report: check,
      });
    },
  };
}
