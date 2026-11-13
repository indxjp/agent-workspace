/**
 * What the recipe route tests share: the recipes, the tokens the scripted platform knows, a
 * {@link RecipeRoutesWorld} to set up before and tear down after each test, and request helpers.
 * It imports no test runner, so the package build can carry it.
 */
import { ApiProblemSchema } from '@indx-workspace/contracts';
import {
  WEBHOOK_SIGNATURE_HEADERS,
  webhookSignedContent,
} from '@indx-workspace/contracts/webhooks';
import { createClient } from '@indx-workspace/sdk';
import { jsonResponse } from '@indx-workspace/sdk/testing';

import { defineRecipe, resourceEvent, schedule } from '../recipe.js';
import { FAKE_WORKSPACE_ID } from '../testing/fake-person.js';
import {
  awaitingApproval,
  completed,
  scriptedPlatform,
} from '../testing/recipe-harness-platform.js';
import {
  resetAppRuntimeForTests,
  setAppRuntimeForTests,
  type TestAppRuntime,
} from '../testing/runtime.js';
import { recipeRoutes, type RecipeRoutes } from './recipe-routes.js';
import { recipeRunner, type RecipeRunner } from './recipe-runner.js';

const TRIAGE_AGENT = '11111111-1111-4111-8111-111111111111';
export const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002';
const BASE = 'https://app.test/api/recipes';

const triageIncident = defineRecipe({
  name: 'triage-incident',
  on: resourceEvent('ticket', 'created'),
  async run({ aw, step }) {
    await step('classify', async () => {
      const { result } = await aw.runs.start(TRIAGE_AGENT, { prompt: 'classify' });
      return (await result).text;
    });
    await step('notify', () => Promise.resolve('notified'));
  },
});

export const sweep = defineRecipe({
  name: 'sla-sweep',
  on: schedule('*/5 * * * *'),
  async run({ step }) {
    await step('sweep', () => Promise.resolve('swept'));
  },
});

export const app = { recipes: [triageIncident, sweep] };

/** The tokens the platform knows: a member, and one the platform refuses every decision to. */
export const MEMBER = 'awo_live_recipesmember';
export const REFUSED = 'awo_live_recipesrefused';
export const STRANGER = 'awo_live_recipesstranger';
/** An Admin of the workspace, who may fire a schedule slot (ADR-0164 T3). */
export const ADMIN = 'awo_live_recipesadmin';

/** What each test runs against; a fresh one per test. */
export interface RecipeRoutesWorld {
  readonly runtime: TestAppRuntime;
  readonly runner: RecipeRunner;
  readonly routes: RecipeRoutes;
  readonly platform: ReturnType<typeof scriptedPlatform>;
  /** The app's webhook secret. */
  readonly secret: string;
  /** The platform as the person: `/api/me`, then the scripted runs. */
  readonly asPerson: typeof fetch;
  /** Overrides every decision's answer from the platform when set; clears it when `undefined`. */
  answerApprovalsWith(response: Response | undefined): void;
}

export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** The Standard Webhooks headers of `body`, delivery `id`, signed at `at` with `key`. */
export async function signed(key: string, body: string, at: Date, id: string): Promise<Headers> {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const raw = Uint8Array.from(atob(key.slice('whsec_'.length)), (char) => char.charCodeAt(0));
  const hmac = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign(
    'HMAC',
    hmac,
    new TextEncoder().encode(webhookSignedContent(id, timestamp, body)),
  );
  return new Headers({
    'content-type': 'application/json',
    [WEBHOOK_SIGNATURE_HEADERS.id]: id,
    [WEBHOOK_SIGNATURE_HEADERS.timestamp]: timestamp,
    [WEBHOOK_SIGNATURE_HEADERS.signature]: `v1,${base64(new Uint8Array(signature))}`,
  });
}

function me(token: string): Response {
  const workspaceId = token === STRANGER ? OTHER_WORKSPACE_ID : FAKE_WORKSPACE_ID;
  return jsonResponse(200, {
    principalId: '00000000-0000-4000-8000-0000000000aa',
    kind: 'membership',
    role: token === ADMIN ? 'admin' : 'builder',
    workspaceId,
    userId: crypto.randomUUID(),
    label: 'Someone',
    features: [],
  });
}

/** A world with its platform, runtime, runner and routes; {@link endRecipeRoutesWorld} ends it. */
export function startRecipeRoutesWorld(): RecipeRoutesWorld {
  let approvalAnswer: Response | undefined;
  const secret = `whsec_${base64(crypto.getRandomValues(new Uint8Array(32)))}`;
  const platform = scriptedPlatform(FAKE_WORKSPACE_ID, {
    [TRIAGE_AGENT]: [awaitingApproval(), completed('triaged')],
  });
  /** The `REFUSED` person's decisions are refused `403`; `approvalAnswer` overrides the rest. */
  const asPerson: typeof fetch = async (input, init) => {
    const href = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /u, '') ?? '';
    if (![MEMBER, REFUSED, STRANGER, ADMIN].includes(token)) {
      return jsonResponse(401, { error: { code: 'unauthenticated', message: 'Sign in.' } });
    }
    const path = new URL(href).pathname;
    if (path === '/api/me') return me(token);
    if (path.endsWith('/approval')) {
      if (token === REFUSED) {
        return jsonResponse(403, { error: { code: 'forbidden', message: 'You may not decide.' } });
      }
      if (approvalAnswer !== undefined) return approvalAnswer;
    }
    return platform.double.fetch(input, init);
  };
  const runtime = setAppRuntimeForTests({ fetch: asPerson, recipeWebhookSecret: secret });
  const runner = recipeRunner(app, {
    client: createClient({
      baseUrl: 'https://aw.test',
      auth: { kind: 'api-key', apiKey: 'app' },
      fetch: platform.double.fetch,
    }),
    store: runtime.recipeStore,
    workspaceId: FAKE_WORKSPACE_ID,
    log: () => undefined,
  });
  return {
    runtime,
    runner,
    routes: recipeRoutes(app, { runner }),
    platform,
    secret,
    asPerson,
    answerApprovalsWith(response) {
      approvalAnswer = response;
    },
  };
}

export async function endRecipeRoutesWorld(world: RecipeRoutesWorld): Promise<void> {
  await world.runner.stop();
  resetAppRuntimeForTests();
}

export function get(path: string, token: string | null = MEMBER): Request {
  return new Request(`${BASE}${path}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

export function post(path: string, body: unknown, token: string | null = MEMBER): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

export const webhookRequest = (headers: Headers, body: string): Request =>
  new Request(`${BASE}/webhook`, { method: 'POST', headers, body });

export const params = <T>(value: T) => ({ params: Promise.resolve(value) });

/** The status and problem code of a refusal. */
export async function problemOf(response: Response): Promise<{ status: number; code: string }> {
  const body = ApiProblemSchema.parse(await response.json());
  return { status: response.status, code: body.error.code };
}

/** A recipe run started and executed until its first step waits for approval; its id. */
export async function waitingRun(world: RecipeRoutesWorld): Promise<string> {
  const run = await world.runner.start(triageIncident, {}, { person: null });
  if (run.status !== 'waiting') throw new Error(`expected a waiting run, got ${run.status}`);
  return run.id;
}
