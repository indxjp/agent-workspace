/**
 * [US-BLD-04][api][run] Builder design §08 "No secret in a result or a log": the run token, the OAuth
 * access token, a connector credential and the `Authorization` header value appear in no tool result
 * and in no log line. Both doors are driven through the e2e harness's production ports, each with a
 * read that succeeds, a refusal, a failed check and an adapter that throws an error whose message
 * carries every secret. The log is what the web logger wrote (`captureLog`), not what its callers
 * passed; each case also proves the surface it searches is not empty.
 */
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryConnectorsStoreProvider } from '../../../connectors/memory-store';
import type { ConnectorsStoreProvider } from '../../../connectors/store';
import type { RunApiEnvironment } from '../../../runs/environment';
import { InMemoryRunStore } from '../../../runs/memory-store';
import { captureLog } from '../../../telemetry/capture-log';
import { log as webLog } from '../../../telemetry/logger';
import { draftBody } from '../../adapters/checker/checker.contract';
import { callContextOf } from '../../testing/context';
import { serveExternalBuilderMcp, type ExternalPrincipal } from '../external';
import { WORKSPACE, approvedFor, builderDoor, gatedInputs } from './harness';

const ORIGIN = 'https://aw.example.test';
const CONNECTOR_CREDENTIAL = 'sk-SENTINEL-connector-credential-4c1d9e07';
const OAUTH_TOKEN = 'awo_live_SENTINELoauthAccessToken4c1d9e07';
const PROVIDER_API_KEY = 'sk-ant-api03-SENTINELproviderKey4c1d9e07';
const ENV_VALUE = 'env-SENTINEL-gateway-4c1d9e07';
const OAUTH_CLIENT_SECRET = 'cs_SENTINELoauthClientSecret4c1d9e07';
/** Short and punctuated: no redaction pattern matches its shape, so only not logging it keeps it out. */
const SHORT_SECRET = 'pw:S3nt!nel';
const OAUTH_AUTHORIZATION = `Bearer ${OAUTH_TOKEN}`;

type Scenario = 'read' | 'refusal' | 'unknown_tool' | 'check_failed' | 'adapter_throws';
const SCENARIOS: readonly Scenario[] = [
  'read',
  'refusal',
  'unknown_tool',
  'check_failed',
  'adapter_throws',
];

/** What left a door for one call, as text, and the typed code it answered (`null` for a success). */
interface Outcome {
  readonly sent: string;
  readonly code: string | null;
}

const EXPECTED_CODE: Record<'run-token' | 'oauth', Record<Scenario, string | null>> = {
  'run-token': {
    read: null,
    refusal: 'not_permitted',
    unknown_tool: 'unknown_tool',
    check_failed: 'agent_definition_references_missing',
    adapter_throws: 'internal_error',
  },
  oauth: {
    read: null,
    refusal: 'read_only_client',
    unknown_tool: 'unknown_tool',
    check_failed: 'agent_definition_references_missing',
    adapter_throws: 'internal_error',
  },
};

const unknownCode = (value: unknown): string | null => {
  const code = (value as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
};

function connectorsWithCredential() {
  const connectors = createInMemoryConnectorsStoreProvider();
  return {
    connectors,
    seed: () =>
      connectors.forWorkspace(WORKSPACE).create(
        {
          name: 'crm-api',
          transport: 'http',
          command: null,
          args: null,
          url: 'https://crm.example.test/mcp',
          authType: 'bearer',
          credential: CONNECTOR_CREDENTIAL,
        },
        { principalId: 'principal-builder', userId: null },
      ),
  };
}

const scopes = () => createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]);
const MODEL = 'scripted:builder-secrets';
const CHECK_FAILS = draftBody('Order desk', ['erp']);

/** The error an adapter throws: its message names every secret, so only redaction can keep them out. */
function poisonedPorts(bait: { text: string }) {
  return {
    catalog: { list: () => Promise.reject(new Error(`upstream rejected ${bait.text}`)) },
  };
}

async function driveRunToken(
  scenario: Scenario,
): Promise<Outcome & { readonly secrets: string[] }> {
  const { connectors, seed } = connectorsWithCredential();
  await seed();
  const bait = { text: '' };
  const door = builderDoor({
    scopes: scopes(),
    connectors,
    ...(scenario === 'adapter_throws' ? { override: poisonedPorts(bait) } : {}),
  });
  const { token } = await door.start({ role: 'builder' }, MODEL);
  const signature = token.split('.').pop() ?? '';
  expect(token).toContain('.');
  bait.text = `Authorization: Bearer ${token} credential ${CONNECTOR_CREDENTIAL} basic ${SHORT_SECRET}`;

  if (scenario === 'refusal') await door.revoke(token);
  const answer = {
    read: () => door.call(token, 'catalog_list', { kinds: ['connectors'] }),
    refusal: () => door.call(token, 'catalog_list', { kinds: ['connectors'] }),
    unknown_tool: () => door.call(token, 'no_such_tool', {}),
    check_failed: () => door.call(token, 'draft_check', { body: CHECK_FAILS }),
    adapter_throws: () => door.call(token, 'catalog_list', { kinds: ['connectors'] }),
  }[scenario]();
  const { result } = await answer;
  return {
    sent: [...door.responses, ...door.responseHeaders, JSON.stringify(door.journal)].join('\n'),
    code: unknownCode(result),
    secrets: [token, signature, `Bearer ${token}`, CONNECTOR_CREDENTIAL, SHORT_SECRET],
  };
}

const principal: ExternalPrincipal = {
  via: 'oauth-token',
  oauth: { clientId: 'client-1', audience: `${ORIGIN}/mcp/builder` },
  scope: { kind: 'builder', id: 'client-1' },
  workspaceId: WORKSPACE,
  principalId: 'principal-builder',
  ownerPrincipalId: 'principal-builder',
  userId: 'user-builder',
  role: 'builder',
  apiKeyId: null,
};

async function driveOAuth(scenario: Scenario): Promise<Outcome> {
  const { connectors, seed } = connectorsWithCredential();
  await seed();
  const bait = {
    text: `Authorization: ${OAUTH_AUTHORIZATION} credential ${CONNECTOR_CREDENTIAL} basic ${SHORT_SECRET}`,
  };
  const door = builderDoor({
    scopes: scopes(),
    connectors,
    ...(scenario === 'adapter_throws' ? { override: poisonedPorts(bait) } : {}),
  });
  const call = (name: string, args: unknown) =>
    new Request(`${ORIGIN}/mcp/builder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: OAUTH_AUTHORIZATION },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  const request = {
    read: () => call('catalog_list', { kinds: ['connectors'] }),
    refusal: () => call('draft_save', { body: CHECK_FAILS }),
    unknown_tool: () => call('no_such_tool', {}),
    check_failed: () => call('draft_check', { body: CHECK_FAILS }),
    adapter_throws: () => call('catalog_list', { kinds: ['connectors'] }),
  }[scenario]();
  const response = await serveExternalBuilderMcp(request, {
    identify: (incoming) =>
      Promise.resolve(
        incoming.headers.get('authorization') === OAUTH_AUTHORIZATION ? principal : null,
      ),
    ports: door.ports,
  });
  const text = await response.text();
  const body = JSON.parse(text) as { result?: { content: { text: string }[] } };
  const [content] = body.result?.content ?? [];
  const result = content === undefined ? undefined : (JSON.parse(content.text) as unknown);
  return {
    sent: `${text}\n${JSON.stringify([...response.headers])}\n${JSON.stringify(door.journal)}`,
    code: unknownCode(result),
  };
}

describe('[US-BLD-04][api][run] no secret reaches a tool result or a log line', () => {
  let log: ReturnType<typeof captureLog>;
  beforeEach(() => {
    vi.stubEnv('AW_PUBLIC_URL', ORIGIN);
    log = captureLog();
  });
  afterEach(() => {
    log.restore();
    vi.unstubAllEnvs();
  });

  function expectNoSecret(sent: string, secrets: readonly string[]): void {
    for (const secret of secrets) {
      expect(sent, 'a tool result or response header').not.toContain(secret);
      expect(log.text(), 'a log line').not.toContain(secret);
    }
  }

  function expectCaptured(scenario: Scenario, sent: string): void {
    expect(sent.length, 'the search covers a real answer').toBeGreaterThan(0);
    if (scenario === 'adapter_throws') {
      expect(log.text(), 'the adapter failure was logged, so the capture works').toContain(
        'builder tool failed',
      );
    }
  }

  it('the detector sees a sentinel in a result and in a written log line', () => {
    expect(() => expectNoSecret(`answer ${SHORT_SECRET}`, [SHORT_SECRET])).toThrow();
    webLog.error('detector probe', { note: SHORT_SECRET });
    expect(log.text()).toContain(SHORT_SECRET);
    expect(() => expectNoSecret('clean', [SHORT_SECRET])).toThrow();
  });

  it.each(SCENARIOS)('run-token door, %s', async (scenario) => {
    const { sent, code, secrets } = await driveRunToken(scenario);
    expect(code).toBe(EXPECTED_CODE['run-token'][scenario]);
    if (scenario === 'read') expect(sent).toContain('crm-api');
    expectCaptured(scenario, sent);
    expectNoSecret(sent, secrets);
  });

  it.each(SCENARIOS)('builder OAuth door, %s', async (scenario) => {
    const { sent, code } = await driveOAuth(scenario);
    expect(code).toBe(EXPECTED_CODE.oauth[scenario]);
    if (scenario === 'read') expect(sent).toContain('crm-api');
    expectCaptured(scenario, sent);
    expectNoSecret(sent, [OAUTH_TOKEN, OAUTH_AUTHORIZATION, CONNECTOR_CREDENTIAL, SHORT_SECRET]);
  });
  describe('a trial or an evaluation whose run API fails (SEC-S2)', () => {
    /** What a failing run API says: the provider key, a process environment value and the OAuth client secret. */
    const RUN_API_TEXT = `${PROVIDER_API_KEY} AW_GATEWAY_TOKEN=${ENV_VALUE} client_secret=${OAUTH_CLIENT_SECRET} basic ${SHORT_SECRET}`;
    const FAILURES = ['run_api_throws', 'run_api_5xx', 'interrupt_fails'] as const;
    type Failure = (typeof FAILURES)[number];
    const TOOLS = ['trial_run', 'evals_run'] as const;
    /** `trial_run` answers the typed refusal; `evals_run` maps it to its own, as the Builder code table has no evaluation twin. */
    const EXPECTED: Record<(typeof TOOLS)[number], Record<Failure, string>> = {
      trial_run: {
        run_api_throws: 'internal_error',
        run_api_5xx: 'internal_error',
        interrupt_fails: 'trial_not_stopped',
      },
      evals_run: {
        run_api_throws: 'internal_error',
        run_api_5xx: 'internal_error',
        interrupt_fails: 'evals_refused',
      },
    };

    /** The run API with `failure` armed once `armed.on`: the approval route and the setup see the working one. */
    function failing(failure: Failure, armed: { on: boolean }) {
      return (base: RunApiEnvironment): RunApiEnvironment => ({
        ...base,
        findAgent: (principal, id) =>
          armed.on && failure === 'run_api_throws'
            ? Promise.reject(new Error(`run API failed: ${RUN_API_TEXT}`))
            : base.findAgent(principal, id),
        openSession: (...args) =>
          armed.on && failure === 'run_api_5xx'
            ? Promise.reject(new Error(`run API answered 502 Bad Gateway: ${RUN_API_TEXT}`))
            : base.openSession(...args),
        launch: (context) => {
          if (!(armed.on && failure === 'interrupt_fails')) return base.launch(context);
          // The run starts and then waits for an approval nobody here will give.
          void (async () => {
            await base.store.markRunning(context.run.id);
            await base.store.awaitApproval(context.run.id, {
              toolName: 'orders_refund',
              canonicalCall: '{}',
            });
          })();
        },
        interruptRun: (principal, run) =>
          failure === 'interrupt_fails'
            ? Promise.reject(Object.assign(new Error(RUN_API_TEXT), { code: 'ECONNRESET' }))
            : (base.interruptRun?.(principal, run) ?? Promise.resolve()),
      });
    }

    async function driveGated(tool: (typeof TOOLS)[number], failure: Failure) {
      const armed = { on: false };
      const door = builderDoor({
        scopes: scopes(),
        runStore: new InMemoryRunStore(),
        wrapRunApi: failing(failure, armed),
      });
      const saved = await door.ports.store.save(
        callContextOf(WORKSPACE, 'builder', 'principal-builder', 'user-builder'),
        { body: draftBody('Order desk', ['crm']) },
      );
      if (!saved.ok) throw new Error('the fixture agent was not saved');
      const input = gatedInputs(saved)[tool];
      const run = await approvedFor(door, tool, input);
      armed.on = true;
      const { result } = await door.call(run.token, tool, input, {}, 'gated-1');
      return {
        sent: [...door.responses, ...door.responseHeaders, JSON.stringify(door.journal)].join('\n'),
        code: unknownCode(result),
        secrets: [
          run.token,
          run.token.split('.').pop() ?? '',
          PROVIDER_API_KEY,
          ENV_VALUE,
          OAUTH_CLIENT_SECRET,
          SHORT_SECRET,
        ],
      };
    }

    it.each(TOOLS.flatMap((tool) => FAILURES.map((failure) => [tool, failure] as const)))(
      '%s with a run API that fails (%s) answers a typed code and leaks no secret',
      async (tool, failure) => {
        const { sent, code, secrets } = await driveGated(tool, failure);
        expect(code).toBe(EXPECTED[tool][failure]);
        expect(sent.length, 'the search covers a real answer').toBeGreaterThan(0);
        expect(log.text(), 'the failure was logged, so the capture works').toContain(
          failure === 'interrupt_fails' ? 'interrupting' : 'builder tool failed',
        );
        expectNoSecret(sent, secrets);
      },
    );

    it('a failed interrupt is logged by class and system code, never by message', async () => {
      await driveGated('trial_run', 'interrupt_fails');
      expect(log.text()).toContain('"errorCode":"ECONNRESET"');
      expect(log.text()).not.toContain('SENTINEL');
    });
  });

  describe('the production composition over a database that is down (SEC-S2)', () => {
    const PG_ERROR = `connection to server at "db.internal" (10.0.0.5), port 5432 failed: FATAL: password authentication failed for user "aw" postgres://aw:${SHORT_SECRET}@db.internal:5432/aw`;

    function downConnectors(): ConnectorsStoreProvider {
      const real = createInMemoryConnectorsStoreProvider();
      return {
        forWorkspace: (workspaceId) => ({
          ...real.forWorkspace(workspaceId),
          list: () => Promise.reject(Object.assign(new Error(PG_ERROR), { code: '57P01' })),
        }),
      };
    }

    it('answers internal_error through the real catalog adapter, with no part of the driver text anywhere', async () => {
      const door = builderDoor({ scopes: scopes(), connectors: downConnectors() });
      const { token } = await door.start({ role: 'builder' }, MODEL);

      const { result } = await door.call(token, 'catalog_list', { kinds: ['connectors'] });

      expect(unknownCode(result)).toBe('internal_error');
      const sent = [...door.responses, ...door.responseHeaders, JSON.stringify(door.journal)].join(
        '\n',
      );
      expect(log.text()).toContain('builder tool failed');
      expectNoSecret(sent, [token, SHORT_SECRET, 'password authentication', '10.0.0.5']);
    });
  });

  describe('a signed run token at the outside door (SEC-S2)', () => {
    it('is a 401 at /mcp/builder: it is not an OAuth access token, and it is neither echoed nor logged', async () => {
      const door = builderDoor({ scopes: scopes() });
      const { token } = await door.start({ role: 'builder' }, MODEL);

      const response = await serveExternalBuilderMcp(
        new Request(`${ORIGIN}/mcp/builder`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'catalog_list', arguments: { kinds: ['connectors'] } },
          }),
        }),
        // The outside door's identity check knows OAuth access tokens and API keys, not run tokens.
        { identify: () => Promise.resolve(null), ports: door.ports },
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
      const sent = `${await response.text()}\n${JSON.stringify([...response.headers])}`;
      expect(door.portCalls).toEqual([]);
      expect(door.journal).toEqual([]);
      expectNoSecret(sent, [token, token.split('.').pop() ?? '']);
    });
  });
});
