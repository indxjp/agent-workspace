import { expect, it } from 'vitest';

import { buildRunRequestFor } from './run-request';
import { GATEWAY, launchContext, rowRunAgent, SETTINGS } from './run-request.fixture.test-support';
export function registerGatewayTokenCases() {
  it('threads a resolved (connection, model) pair through to the composed request', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      undefined,
      null,
      undefined,
      { connectionId: '88888888-8888-4888-8888-888888888888', model: 'resolved-model' },
    );
    expect(request.portable.model).toBe('resolved-model');
  });
}
