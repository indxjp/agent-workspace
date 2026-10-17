#!/usr/bin/env node
/**
 * `@indx-workspace/cli` — the npx project generator and operator CLI.
 *
 * `create-agent-workspace` (`create.ts`) writes a project. Without `--cloud` that is a
 * `kind: Project` directory, which `aw dev` runs; with `--cloud local` (or a cloud) it is the
 * Compose project this binary operates:
 * `agent-workspace start` brings the deployment up, `agent-workspace stop` takes it down with the
 * runtime sandboxes its runner started, `agent-workspace validate` checks the deployment profile
 * and probes the stores it names, `agent-workspace render` re-renders the generated files from
 * an edited profile, `agent-workspace doctor` reports whether the project can start, and
 * `agent-workspace deploy` takes that profile to the running deployment.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runAsProcess } from './cli-failure.ts';
import { versionText } from './version.ts';

export { CLI_PUBLISHED_PACKAGE as PACKAGE_NAME } from './contracts-skew.ts';

// The surface `packages/embedded` (the repository's development-only embedded workspace) needs.
export { runAsProcess } from './cli-failure.ts';
export { assertServerServesContracts } from './contracts-skew.ts';
export { detectHostCapabilities, type HostCapabilities } from './host-capabilities.ts';
// The runtime facts the CLI restates; `packages/embedded/src/runtime-pins.test.ts` pins them.
export { CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY } from './deployment.ts';
// The sandbox labels `stop` filters on; the same test pins them to the Docker driver.
export { COMPOSE_PROJECT_LABEL, SANDBOX_LABEL } from './stop.ts';
export type { RuntimeDriverId } from './profile.ts';

/** Fail-closed ESM entry detection, including package-manager bin symlinks. */
export function isMainModule(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined || entry.length === 0) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/** The verbs this binary answers to, in the order the usage line names them. */
const VERBS = ['start', 'stop', 'validate', 'render', 'doctor', 'deploy'] as const;

/** What `--help` prints: the verbs, and where the generator and the embedded mode are. */
// Each verb's own arguments are on its line: `stop` takes no directory, so the usage line names none.
// The pack smoke (`scripts/release/pack-packages.mjs`) matches this line's prefix.
export const HELP_TEXT = `Usage: agent-workspace ${VERBS.join('|')}

  start              start, in this directory, the Compose project that
                     npm create @indx-workspace <directory> -- --cloud local generates
  stop [--volumes]   stop it and remove its runtime sandboxes and networks; --volumes also
                     removes its data volumes
  validate [dir]     re-check agent-workspace.yaml and probe the stores it names
  render [dir] [--check] [--upgrade]
                     re-render deploy/, compose.yaml and the .env image pins from
                     agent-workspace.yaml; --check fails on drift and writes nothing;
                     --upgrade moves the platform image pins to this CLI's release
  doctor [dir] [--json]
                     check the profile, the stores, the tools on PATH the target needs and
                     the server's contracts version; exits 1 when any check fails
  deploy [dir] [--yes] [--target helm|terraform|vercel|cloudflare] [--infra <dir>]
                     render, then print the plan of docker compose, helm, terraform, vercel or wrangler
                     for the profile's target; --yes applies it. Exits 2 when changes
                     are pending; --infra names the repository's infra/ for a cloud target
  --version          print the CLI version and the contracts version it was built against

npm create @indx-workspace <directory> writes a kind: Project directory, which aw dev runs.
These commands operate the Compose project that
npm create @indx-workspace <directory> -- --cloud local generates.
`;

/**
 * Dispatch a verb, or refuse. Resolves with the exit code of a command that completed: 0, or
 * `deploy`'s 2 for a plan with changes it was not told to apply.
 *
 * An unrecognised verb is a usage error rather than a silent return: `agent-workspace valdiate
 * acme-ai` would otherwise exit 0 and print nothing, which in a deploy pipeline reads as a
 * validation gate that passed — the one outcome this command exists to make impossible.
 */
export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const verb = argv[0];
  if (verb === '--help' || verb === '-h' || verb === 'help') {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (verb === '--version' || verb === '-v') {
    process.stdout.write(versionText());
    return 0;
  }
  if (verb === 'validate') {
    const { runValidateCommand } = await import('./validate.ts');
    await runValidateCommand(argv.slice(1));
    return 0;
  }
  if (verb === 'render') {
    const { runRenderCommand } = await import('./render.ts');
    await runRenderCommand(argv.slice(1));
    return 0;
  }
  if (verb === 'deploy') {
    const { DEPLOY_CHANGES_PENDING, runDeployCommand } = await import('./deploy/command.ts');
    const { changes, applied } = await runDeployCommand(argv.slice(1));
    return changes && !applied ? DEPLOY_CHANGES_PENDING : 0;
  }
  if (verb === 'doctor') {
    const { runDoctorCommand } = await import('./doctor/index.ts');
    await runDoctorCommand(argv.slice(1));
    return 0;
  }
  if (verb === 'stop') {
    const { runStopCommand } = await import('./stop.ts');
    await runStopCommand(argv.slice(1));
    return 0;
  }
  if (verb === 'start') {
    const { runStartCommand } = await import('./start.js');
    await runStartCommand(argv.slice(1));
    return 0;
  }
  throw new Error(
    `${verb === undefined ? 'agent-workspace needs a command' : `Unknown command ${JSON.stringify(verb)}`}. ` +
      `Usage: agent-workspace ${VERBS.join('|')}; \`agent-workspace --help\` lists each command's arguments.`,
  );
}

if (isMainModule(process.argv[1], import.meta.url)) {
  let completed = 0;
  const status = await runAsProcess(async () => {
    completed = await runCli();
  });
  process.exitCode = status === 0 ? completed : status;
}
