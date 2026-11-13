import { firstStderrLine } from './cloud-run-images.ts';
import { createRedactor } from './redact.ts';
import { type DeployContext } from './steps.ts';

/** The command that repeats a deploy that stopped half way; every step is safe to repeat. */
export function deployRerunCommand(apply: boolean): string {
  return apply ? 'aw deploy production --yes' : 'aw deploy production';
}

function seconds(started: number): string {
  return `${String(Math.max(0, Math.round((Date.now() - started) / 1000)))} s`;
}

/** The first line of `stderr` that Terraform calls an error, else its first line with text. */
function actionableLine(stderr: string): string {
  const error = stderr
    .split('\n')
    .map((line) => line.replace(/^[\s╷│╵]+/u, '').trim())
    .find((line) => line.startsWith('Error'));
  return error ?? firstStderrLine(stderr);
}

export interface StepReport {
  /** The command that repeats the step. */
  readonly rerun?: string;
  /** Quote the thrown error, not the first line the tools printed (warnings included). */
  readonly quoteError?: boolean;
  /** Masks the failure's quoted text; defaults to the redactor that knows no `.env` value. */
  readonly redact?: (text: string) => string;
  /** A sentence added to the failure when the tools' stderr says why it happened. */
  readonly advise?: (stderr: string) => string | undefined;
}

/**
 * Run one lifecycle step, printing its title and its elapsed time. A failure is reported as the
 * step, the first actionable error line of what the tools printed (redacted) and the command that
 * repeats the step; the tools' own output was already printed in full.
 */
export async function lifecycleStep<T>(
  context: DeployContext,
  title: string,
  run: (context: DeployContext) => Promise<T>,
  { rerun = deployRerunCommand(true), advise, quoteError = false, redact }: StepReport = {},
): Promise<T> {
  const started = Date.now();
  let stderr = '';
  context.out(`${title} ...\n`);
  try {
    const result = await run({
      ...context,
      err: (text) => {
        stderr += text;
        context.err(text);
      },
    });
    context.out(`${title}: done in ${seconds(started)}\n`);
    return result;
  } catch (error) {
    const detail =
      quoteError || stderr.trim() === ''
        ? error instanceof Error
          ? error.message
          : String(error)
        : actionableLine(stderr);
    const advice = advise?.(stderr);
    throw new Error(
      `${title} failed after ${seconds(started)}: ${(redact ?? createRedactor({}))(detail)}\n` +
        `${advice === undefined ? '' : `${advice}\n`}` +
        `Every step is safe to repeat. Run it again: ${rerun}`,
      { cause: error },
    );
  }
}
