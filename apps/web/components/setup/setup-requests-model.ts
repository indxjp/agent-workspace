import {
  ApiProblemSchema,
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_HEADER,
  type ApiProblem,
} from '@indx-workspace/contracts';
import { z } from 'zod';

/*
 * W3-7 (#1356): how the first-run wizard reads its two answers. The calls themselves stay raw
 * `fetch` in setup-wizard.tsx, under its existing budget and suppression entries: `POST
 * /api/setup` is out of the SDK's scope permanently (docs/sdk/04-api-specification.md §1, a
 * browser journey), and `GET /api/setup/runtime-detect` gets an SDK method only after it moves to
 * `/api/runtimes/detect` (S-9, unit 9 #241). Both are pre-auth and only the wizard calls them, so
 * a published SDK method for either would be speculative.
 */

const RuntimeDetectionSchema = z
  .object({
    defaultDriver: z.string().min(1),
    drivers: z.array(
      z.object({ id: z.string().min(1), available: z.boolean(), reason: z.string() }),
    ),
  })
  .readonly();

export type RuntimeDetection = z.infer<typeof RuntimeDetectionSchema>;

const SetupCompletedSchema = z.object({ agentId: z.string().min(1) });

type SetupOutcome =
  | { readonly ok: true; readonly agentId: string }
  | { readonly ok: false; readonly message: string };

export const INVALID_ADMIN_CREDENTIALS_MESSAGE =
  'The administrator email or one-time setup password did not match. Use the values the ' +
  'generator printed: BOOTSTRAP_ADMIN and BOOTSTRAP_ADMIN_PASSWORD in the project .env file, ' +
  'not a password your browser suggested or saved.';

export const SETUP_UNANSWERED = 'Setup could not reach the server. Check the connection and retry.';

/** The text shown when `POST /api/setup` refuses: the server's own message, made actionable. */
function setupFailureMessage(status: number, problem: ApiProblem | null): string {
  if (problem?.error.code === 'invalid_credentials') return INVALID_ADMIN_CREDENTIALS_MESSAGE;
  return problem?.error.message ?? `Setup returned ${String(status)}.`;
}

/** The headers both setup calls send: the contracts version the wizard was built against. */
export const SETUP_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  [CONTRACTS_VERSION_HEADER]: CONTRACTS_VERSION,
};

/**
 * Reads the answer to `POST /api/setup`. The refusal text is the server's (which already redacts
 * the submitted secrets) or the status, never anything built from the submission.
 */
export async function setupOutcomeOf(response: Response): Promise<SetupOutcome> {
  const body: unknown = await response.json().catch(() => null);
  const completed = SetupCompletedSchema.safeParse(body);
  if (response.ok && completed.success) return { ok: true, agentId: completed.data.agentId };
  const problem = ApiProblemSchema.safeParse(body);
  return {
    ok: false,
    message: setupFailureMessage(response.status, problem.success ? problem.data : null),
  };
}

/**
 * The outcome when `POST /api/setup` never answered. The error is ignored on purpose: its text
 * may name the request, which carries secrets.
 */
export function setupUnanswered(): SetupOutcome {
  return { ok: false, message: SETUP_UNANSWERED };
}

/** Reads the answer to `GET /api/setup/runtime-detect`; `null` on a refusal or an odd shape. */
export async function detectionOf(response: Response): Promise<RuntimeDetection | null> {
  if (!response.ok) return null;
  const parsed = RuntimeDetectionSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}
