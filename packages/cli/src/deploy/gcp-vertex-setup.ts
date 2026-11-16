import { field } from './gcp-json-fields.ts';
import type { VertexSeed } from './gcp-lifecycle.ts';
import { type DeployContext } from './steps.ts';

const SEED_AGENT_NAME = 'Assistant';

const SEED_AGENT_INSTRUCTIONS = 'You are a helpful assistant.';

/** What the seeding waits for a new revision to warm up: 24 tries, 5 s apart (about 2 minutes). */
const SEED_ATTEMPTS = 24;

const SEED_INTERVAL_MS = 5000;

/**
 * Web's setup code for the runner manager's Cloud Run front end refusing web with an HTML 403
 * (`apps/web/server/setup/failure.ts`): web's `roles/run.invoker` grant, applied moments ago, has
 * not propagated yet. Setup writes nothing before its runtime test, so it is retried, with a
 * doubling delay, for at most `FORBIDDEN_WAIT_MS`; no other refusal is.
 */
const RUNTIME_MANAGER_FORBIDDEN = 'runtime_manager_forbidden';

const FORBIDDEN_WAIT_MS = 180_000;

const FORBIDDEN_FIRST_DELAY_MS = 5000;

const FORBIDDEN_MAX_DELAY_MS = 30_000;

/** The next wait for a propagating grant (5 s doubling to 30 s), or `null` once `FORBIDDEN_WAIT_MS` is spent. */
function grantPropagationDelays(): () => number | null {
  let waitedMs = 0;
  let nextMs = FORBIDDEN_FIRST_DELAY_MS;
  return () => {
    const delayMs = Math.min(nextMs, FORBIDDEN_WAIT_MS - waitedMs);
    if (delayMs <= 0) return null;
    waitedMs += delayMs;
    nextMs = Math.min(nextMs * 2, FORBIDDEN_MAX_DELAY_MS);
    return delayMs;
  };
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** The error `code` a refusal names, else `null`: never the rest of the body. */
async function refusalCode(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  const code = field(field(body, 'error'), 'code');
  return typeof code === 'string' ? code : null;
}

type SetupAttempt =
  | { readonly status: 'connected' }
  | { readonly status: 'refused' | 'not-ready' | 'grant-pending'; readonly reason: string };

function setupRequest(seed: VertexSeed, password: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: seed.webUrl },
    body: JSON.stringify({
      provider: 'vertex',
      providerApiKey: '',
      runtime: 'cloud-run-service',
      adminEmail: seed.adminEmail,
      adminPassword: password,
      agentName: SEED_AGENT_NAME,
      agentInstructions: SEED_AGENT_INSTRUCTIONS,
    }),
  };
}

async function attemptSetup(
  context: DeployContext,
  seed: VertexSeed,
  request: RequestInit,
  warn: (reason: string) => false,
): Promise<SetupAttempt> {
  try {
    const response = await (seed.fetch ?? fetch)(`${seed.webUrl}/api/setup`, request);
    if (response.ok) {
      context.out(
        `model: Claude on Vertex AI (${seed.location}), using this install's Google Cloud identity\n`,
      );
      return { status: 'connected' };
    }
    const code = await refusalCode(response);
    const reason = `HTTP ${String(response.status)}${code === null ? '' : ` ${code}`}`;
    if (code === RUNTIME_MANAGER_FORBIDDEN) return { status: 'grant-pending', reason };
    if (response.status === 503) return { status: 'not-ready', reason };
    warn(reason);
    return { status: 'refused', reason };
  } catch {
    return { status: 'not-ready', reason: 'no connection' };
  }
}

/** Revision readiness and IAM propagation have separate retry budgets. */
function setupRetryDelay(
  context: DeployContext,
): (status: SetupAttempt['status']) => number | null {
  const nextGrantDelay = grantPropagationDelays();
  let notReadyAttempts = 0;
  let waitingForGrant = false;
  return (status) => {
    if (status !== 'grant-pending') {
      notReadyAttempts += 1;
      return notReadyAttempts >= SEED_ATTEMPTS ? null : SEED_INTERVAL_MS;
    }
    const delayMs = nextGrantDelay();
    if (delayMs === null) return null;
    if (!waitingForGrant) context.out('Waiting for the new permission to reach Cloud Run...\n');
    waitingForGrant = true;
    return delayMs;
  };
}

/**
 * The first deploy's model: complete the web app's setup with Claude on this install's own Vertex
 * AI (`POST /api/setup`, the path the setup wizard takes), so the install needs no model key. It
 * waits for a new revision to answer (503 or no connection), and for about three minutes for web's
 * new invoker grant on the runner manager to take effect (`runtime_manager_forbidden`). Whatever
 * fails is printed as a warning with the next step; the deploy still succeeds.
 *
 * @returns whether the connection was made.
 */
export async function seedVertexConnection(
  context: DeployContext,
  seed: VertexSeed,
): Promise<boolean> {
  const next = `next: open ${seed.webUrl} and choose Claude on Google Cloud (Vertex AI) in setup`;
  const warn = (reason: string): false => {
    context.out(`warning: Claude on Vertex AI was not connected (${reason})\n${next}\n`);
    return false;
  };
  let password: string;
  try {
    password = await seed.password();
  } catch {
    return warn('the Owner password could not be read');
  }
  const request = setupRequest(seed, password);
  const wait = seed.sleep ?? pause;
  const nextDelay = setupRetryDelay(context);
  for (;;) {
    const attempt = await attemptSetup(context, seed, request, warn);
    if (attempt.status === 'connected') return true;
    if (attempt.status === 'refused') return false;
    const delayMs = nextDelay(attempt.status);
    if (delayMs === null) return warn(attempt.reason);
    await wait(delayMs);
  }
}
