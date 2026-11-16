/* global fetch, setTimeout, console */

/**
 * Start `agentName` from the signed-in console and wait until the run ends.
 *
 * @param {import('@playwright/test').Page} page @param {string} agentName
 */
export async function startAndWaitForAgentRun(page, agentName) {
  return page.evaluate(async (name) => {
    const agentsResponse = await fetch('/api/agents');
    const agents = await agentsResponse.json();
    const agent = agents.agents.find(
      (/** @type {{ name: string }} */ entry) => entry.name === name,
    );
    if (agent === undefined) throw new Error(`no agent ${name}`);
    const started = await fetch(`/api/agents/${agent.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Close the ticket.' }),
    });
    const body = await started.json();
    if (started.status >= 300)
      throw new Error(`run start answered ${String(started.status)}: ${JSON.stringify(body)}`);
    const id = body.id ?? body.run?.id;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const currentResponse = await fetch(`/api/runs/${id}`);
      const current = await currentResponse.json();
      const status = current.status ?? current.run?.status;
      if (['completed', 'failed', 'cancelled'].includes(status)) return { id, status, current };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`run ${id} did not end`);
  }, agentName);
}

/**
 * A run of `agentName` started on the platform with the exchanged `awo_live_` token is the
 * Owner's: its initiating person is the signed-in console's. The person token `aw login` holds
 * is still `401` on the same run route (ADR-0083, ADR-0161 DI12).
 *
 * @param {import('@playwright/test').Page} page the Owner's signed-in console
 * @param {{ origin: string, accessToken: string, personToken: string, agentName: string }} options
 * @returns {Promise<string>} the run's id
 */
export async function startAndVerifyOwnerRun(page, options) {
  const { accessToken } = options;
  const { agentId, ownerId } = await page.evaluate(async (name) => {
    const agentsResponse = await fetch('/api/agents');
    const agents = await agentsResponse.json();
    const meResponse = await fetch('/api/me');
    const me = await meResponse.json();
    return {
      agentId: agents.agents.find((/** @type {{ name: string }} */ entry) => entry.name === name)
        ?.id,
      ownerId: me.userId,
    };
  }, options.agentName);
  const runs = `${options.origin}/api/agents/${String(agentId)}/runs`;
  const body = JSON.stringify({ prompt: 'Say hello.' });
  const headers = (/** @type {string} */ bearer) => ({
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
  });
  const refused = await fetch(runs, {
    method: 'POST',
    headers: headers(options.personToken),
    body,
  });
  if (refused.status !== 401)
    throw new Error(
      `the person token answered ${String(refused.status)} on the run route, not 401`,
    );
  const started = await fetch(runs, { method: 'POST', headers: headers(accessToken), body });
  const run = await started.json();
  if (started.status !== 202)
    throw new Error(`the run start answered ${String(started.status)}: ${JSON.stringify(run)}`);
  const response = await fetch(`${options.origin}/api/runs/${String(run.run?.id)}`, {
    headers: headers(accessToken),
  });
  const read = await response.json();
  if (read.run?.initiatingUserId !== ownerId)
    throw new Error(
      `the run's initiating person is ${String(read.run?.initiatingUserId)}, not the Owner ${String(ownerId)}`,
    );
  console.log(`== the ${options.agentName} run started through the app is the Owner's`);
  return String(run.run?.id);
}
