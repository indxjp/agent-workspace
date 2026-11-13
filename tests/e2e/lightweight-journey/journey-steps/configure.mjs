import { randomBytes } from 'node:crypto';

import process from 'node:process';

import { StackClient } from '../../../generated-project/stack-api.mjs';

import { DECLARED_SECRET } from '../../tool-sandbox.e2e.mjs';

/** @param {ReturnType<typeof import('../journey.e2e.mjs').createJourneyContext>} context */
export function createConfigureStep(context) {
  const {
    lane,
    secrets,
    s,
    check,
    remember,
    sandboxDriver,
    control,
    controlPlaneLogs,
    bearer,
    refusedPush,
    setupAnswered,
    awaitSetup,
    vercelLogExcerpt,
  } = context;

  async function waitForDeployment() {
    try {
      await awaitSetup(control());
    } catch (error) {
      if (lane.host !== 'vercel') throw error;
      secrets.push(process.env['VERCEL_TOKEN'] ?? '');
      const excerpt = vercelLogExcerpt({
        url: control(),
        team: process.env['VERCEL_TEAM_ID'] ?? '',
        token: process.env['VERCEL_TOKEN'] ?? '',
      });
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} — runtime log: ${excerpt}`,
        { cause: error },
      );
    }
  }
  /** @param {StackClient} client */
  async function configureApiIdentity(client) {
    const minted = await client.request('/api/api-keys', {
      method: 'POST',
      body: { name: 'lightweight-journey', role: 'admin', expiresAt: null },
    });
    s['apiKey'] = minted.json?.key;
    check(typeof s['apiKey'] === 'string', 'an API key was minted for aw');
    secrets.push(s['apiKey']);
    // The workspace the runner tags this lane's E2B sandboxes with; the end-of-lane sweep finds them by it.
    const me = await client.request('/api/me', { apiKey: s['apiKey'] });
    check(typeof me.json?.workspaceId === 'string', 'aw resolved the workspace the lane runs in');
    s['workspaceId'] = me.json.workspaceId;
  }
  return {
    async configure() {
      const client = new StackClient(control());
      const request = client.request.bind(client);
      client.request = (route, options) => request(route, options).then(remember);
      s['client'] = client;
      await waitForDeployment();
      // The sandbox provider's credential travels with first-run setup, which stores it as the
      // encrypted `<driver> default` runtime connection and tests the runtime with it (ADR-0088).
      const credential = {
        external: [process.env['E2B_API_KEY'] ?? '', 'https://api.e2b.dev'],
        'vercel-sandbox': [process.env['VERCEL_TOKEN'] ?? '', 'https://api.vercel.com'],
        'cloudflare-sandbox': [s['bridgeSecret'] ?? '', s['bridgeUrl'] ?? ''],
      }[sandboxDriver];
      const setup = await client
        .setup({
          provider: 'anthropic',
          providerApiKey: s['providerKey'],
          providerBaseUrl: s['providerUrl'],
          runtime: sandboxDriver,
          runtimeCredential: credential?.[0],
          runtimeEndpoint: credential?.[1],
          adminEmail: s['stateEnv']['BOOTSTRAP_ADMIN'] ?? '',
          adminPassword: s['stateEnv']['BOOTSTRAP_ADMIN_PASSWORD'] ?? '',
          agentName: 'journey setup agent',
          agentInstructions: 'Answer briefly.',
        })
        .then((answer) => {
          setupAnswered(lane.refusal, answer, check);
          return answer;
        })
        .catch((/** @type {unknown} */ error) => {
          if (lane.host !== 'vercel') throw error;
          // The control plane answers a bare 500; the cause is in its log and in the manager's.
          throw controlPlaneLogs(error);
        });
      await configureApiIdentity(client);
      const profile = await client.request('/api/runtime-profiles', {
        method: 'POST',
        body: {
          name: 'journey-sandbox',
          driver: sandboxDriver,
          runtimeConnectionId: setup.json?.runtimeConnectionId,
          networkPolicy: 'none',
          filesystem: 'read-write',
        },
      });
      check(
        profile.status === 201,
        `the runtime profile was created (${String(profile.status)} ${profile.text.slice(0, 200)})`,
      );
      s['declared'] = `journey-declared-${randomBytes(6).toString('hex')}`;
      secrets.push(s['declared']);
      const secret = await client.request('/api/secrets', {
        method: 'POST',
        body: { name: DECLARED_SECRET, value: s['declared'] },
      });
      check(secret.status === 201, `the declared secret was set (${String(secret.status)})`);

      if (lane.pushRefusal !== undefined) {
        // The push exits 1 with problem lines; the chapters that need the agent record the proof.
        s['pushRefused'] = refusedPush(
          lane.pushRefusal,
          s['created'].aw(['push', '--yes'], bearer(), 1),
          check,
        );
        return s['pushRefused'];
      }
      s['created'].aw(['push', '--yes'], bearer());
      const agents = (await client.request('/api/agents')).json?.agents ?? [];
      const agent = agents.find(
        (/** @type {{ name: string }} */ a) => a.name === s['created'].agentName,
      );
      check(agent !== undefined, 'aw push created the agent on the deployment');
      s['agentId'] = agent.id;
      const attached = await client.request(`/api/agents/${agent.id}`, {
        method: 'PATCH',
        body: { runtimeProfileId: profile.json?.id },
      });
      check(
        attached.status === 200,
        `the runtime profile was attached (${String(attached.status)})`,
      );
    },
  };
}
