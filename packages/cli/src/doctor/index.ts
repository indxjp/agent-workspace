/**
 * `agent-workspace doctor [dir] [--json]` — whether this project can start, and whether this CLI
 * matches the server it talks to, in one run.
 *
 * Five checks — the profile, the storage setting, its stores, the tools its target needs on
 * `PATH`, and the server's contracts version — each report pass, warn or fail with one line of advice. The report is
 * written in full before the command refuses, so a failure exits 1 with every finding visible and
 * warnings alone exit 0. Every probe is injectable: the suite needs neither Docker nor a network.
 */
import path from 'node:path';

import type { CommandProbe } from '../host-capabilities.ts';
import { projectEnvironment, ProjectEnvironmentError, type ProfileProbes } from '../validate.ts';
import {
  checkComposeOrigins,
  checkProfile,
  checkStorage,
  checkStores,
  checkVersionSkew,
  notChecked,
  type DoctorCheck,
} from './checks.ts';
import { checkPrerequisites, runToolCommand } from './prerequisites.ts';
import { collectSecrets, redact } from './redact.ts';

export interface DoctorOptions {
  readonly probes?: ProfileProbes;
  readonly command?: CommandProbe;
  readonly fetch?: typeof fetch;
  /** Replaces the project `.env` merged over `process.env`. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly stdout?: (text: string) => void;
}

const USAGE = 'Usage: agent-workspace doctor [dir] [--json]';

interface DoctorArguments {
  readonly directory: string;
  readonly json: boolean;
}

function parseArguments(argv: readonly string[]): DoctorArguments {
  let directory: string | undefined;
  let json = false;
  for (const argument of argv) {
    if (argument === '--json') {
      json = true;
    } else if (argument.startsWith('-')) {
      throw new Error(
        `agent-workspace doctor: unknown option ${JSON.stringify(argument)}. ${USAGE}`,
      );
    } else if (directory === undefined) {
      directory = argument;
    } else {
      throw new Error(`agent-workspace doctor takes one directory. ${USAGE}`);
    }
  }
  return { directory: path.resolve(directory ?? process.cwd()), json };
}

type EnvironmentReading =
  | { readonly environment: Readonly<Record<string, string | undefined>> }
  | { readonly failure: DoctorCheck };

async function readEnvironment(
  directory: string,
  options: DoctorOptions,
): Promise<EnvironmentReading> {
  if (options.environment !== undefined) return { environment: options.environment };
  try {
    return { environment: await projectEnvironment(directory) };
  } catch (error) {
    if (!(error instanceof ProjectEnvironmentError)) throw error;
    return {
      failure: {
        check: 'stores',
        subject: '.env',
        status: 'fail',
        detail: error.message,
        advice: 'Correct the line in .env that is not NAME=value or a comment.',
      },
    };
  }
}

/** Every check, in order; a check whose input an earlier one refused is reported unchecked. */
async function runChecks(
  directory: string,
  options: DoctorOptions,
): Promise<{ readonly checks: readonly DoctorCheck[]; readonly secrets: readonly string[] }> {
  const profileOutcome = await checkProfile(directory);
  const reading = await readEnvironment(directory, options);
  const checks: DoctorCheck[] = [...profileOutcome.checks];
  const { profile } = profileOutcome;
  const environment = 'environment' in reading ? reading.environment : null;

  checks.push(
    environment === null
      ? notChecked('storage', 'AW_STORAGE_URL', '.env could not be read')
      : checkStorage(environment),
  );
  const origins =
    environment === null || profile === null ? null : checkComposeOrigins(profile, environment);
  if (origins !== null) checks.push(origins);

  if ('failure' in reading) {
    checks.push(reading.failure);
  } else if (profile === null) {
    checks.push(notChecked('stores', 'stores', 'the profile did not validate'));
  } else {
    checks.push(...(await checkStores(profile, reading.environment, options)));
  }

  checks.push(
    ...(profile === null
      ? [notChecked('prerequisites', 'tools', 'the profile did not validate')]
      : checkPrerequisites(profile, options.command ?? runToolCommand)),
  );

  checks.push(
    environment === null
      ? notChecked('version-skew', 'server', '.env could not be read')
      : await checkVersionSkew(environment, options),
  );

  return { checks, secrets: collectSecrets(environment ?? {}, profileOutcome.text) };
}

function redactCheck(check: DoctorCheck, secrets: readonly string[]): DoctorCheck {
  return {
    ...check,
    subject: redact(check.subject, secrets),
    detail: redact(check.detail, secrets),
    advice: check.advice === null ? null : redact(check.advice, secrets),
  };
}

function renderText(checks: readonly DoctorCheck[]): string {
  const width = Math.max(...checks.map((check) => check.check.length));
  const lines = checks.flatMap(({ status, check, subject, detail, advice }) => [
    `${status.padEnd(4)}  ${check.padEnd(width)}  ${subject}: ${detail}`,
    ...(advice === null ? [] : [`${' '.repeat(6 + width + 2)}${advice}`]),
  ]);
  const count = (status: DoctorCheck['status']) =>
    checks.filter((check) => check.status === status).length;
  lines.push(
    `${String(count('pass'))} passed, ${String(count('warn'))} warned, ${String(count('fail'))} failed`,
  );
  return `${lines.join('\n')}\n`;
}

/** Run every check, write the report, then refuse if any check failed. */
export async function runDoctorCommand(
  argv: readonly string[] = [],
  options: DoctorOptions = {},
): Promise<void> {
  const { directory, json } = parseArguments(argv);
  const { checks: found, secrets } = await runChecks(directory, options);
  const checks = found.map((check) => redactCheck(check, secrets));
  const failed = checks.filter((check) => check.status === 'fail').length;
  const write = options.stdout ?? ((text: string) => void process.stdout.write(text));
  write(json ? `${JSON.stringify({ ok: failed === 0, checks }, null, 2)}\n` : renderText(checks));
  if (failed > 0) {
    throw new Error(
      `agent-workspace doctor: ${String(failed)} check${failed === 1 ? '' : 's'} failed`,
    );
  }
}
