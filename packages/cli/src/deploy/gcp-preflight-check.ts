/** The shared vocabulary of the Google Cloud preflight checks: a check's result and how a tool is probed. */
import { runStep, type DeployContext } from './steps.ts';

export type GcpPreflightStatus = 'ok' | 'fail' | 'warn' | 'fixed';

export interface GcpPreflightCheck {
  readonly id: string;
  readonly title: string;
  readonly status: GcpPreflightStatus;
  /** The one copy-paste command (or URL) that resolves the check. */
  readonly fix?: string;
}

export type Probe = { readonly ok: true; readonly stdout: string } | { readonly ok: false };

export type Gcloud = (args: readonly string[]) => Promise<Probe>;

/** The command that signs gcloud's own account in. */
export const ACCOUNT_SIGN_IN = 'gcloud auth login';

export async function probe(
  context: DeployContext,
  tool: 'gcloud' | 'terraform' | 'docker',
  args: readonly string[],
): Promise<Probe> {
  try {
    const result = await runStep(context, tool, args, { show: false });
    return { ok: true, stdout: result.stdout };
  } catch {
    // The failure (a missing tool or a non-zero exit) is the check's result; `runStep` has
    // already printed what the tool said.
    return { ok: false };
  }
}

export function check(
  id: string,
  title: string,
  status: GcpPreflightStatus,
  fix?: string,
): GcpPreflightCheck {
  return fix === undefined ? { id, title, status } : { id, title, status, fix };
}

export function enableCommand(apis: readonly string[], project: string): string {
  return `gcloud services enable ${apis.join(' ')} --project ${project}`;
}

/** The bearer headers of a Google API call; the token is sent and never printed. */
export function bearerHeaders(token: string, json: boolean): Record<string, string> {
  return json
    ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    : { authorization: `Bearer ${token}` };
}
