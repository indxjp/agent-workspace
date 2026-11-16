/* global console */
import { installTypecheckPackages, checkProjectTypes } from './run-packages.mjs';

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { run } from '../generated-project/project.mjs';
import { SIGN_IN_PROOF_ROUTE, signInProofRoute } from './run-sign-in-proof.mjs';
import { withTarballs, npmInstall, editJson } from './run-packages.mjs';
import {
  APP_NAME,
  PROJECT_NAME,
  SCRIPTED_MODEL,
  withAgentWrite,
  withModel,
} from './run-project-source.mjs';
export { TYPE_CHECK_PACKAGES, withTarballs, packPackages, npmInstall } from './run-packages.mjs';
export {
  APP_NAME,
  PROJECT_NAME,
  SCRIPTED_MODEL,
  withAgentWrite,
  withModel,
  closeTicketScript,
} from './run-project-source.mjs';

/** The portal case's project, written by `create --template portal`. */
export const PORTAL_PROJECT = 'portal';

/** The workflow `create --template portal` writes, relative to the project. */
export const APP_CI_WORKFLOW = '.github/workflows/app-ci.yml';

/**
 * The `run:` steps of the generated app CI, in order: each is one line (the SDK's template test
 * holds them so), so a line match reads them exactly as a YAML parser does.
 *
 * @param {string} workflow
 */
export function ciRunSteps(workflow) {
  return [...workflow.matchAll(/^ {6}- run: (.+)$/gmu)].map((match) => match[1] ?? '');
}

/**
 * `command` run by the shell in `cwd`: its exit status and output, never thrown.
 *
 * @param {string} command @param {string} cwd @param {NodeJS.ProcessEnv} env
 */
function shell(command, cwd, env) {
  const result = spawnSync('sh', ['-c', command], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * The portal case: the generated portal type-checks and its CI passes, and each planted platform
 * reach makes that CI exit non-zero.
 *
 * @param {{work: string, create: string, tarballs: Record<string, string>, env: NodeJS.ProcessEnv}} options
 */
export function portalCase({ work, create, tarballs, env }) {
  console.log('== portal: create --template portal');
  run(process.execPath, [create, PORTAL_PROJECT, '--template', 'portal', '--yes', '--no-install'], {
    cwd: work,
    env,
  });
  const project = path.join(work, PORTAL_PROJECT);
  const manifest = path.join(project, 'package.json');
  if (!readFileSync(path.join(project, 'aw-generated.json'), 'utf8').includes('"app:portal"')) {
    throw new Error('aw-generated.json records no app:portal');
  }
  editJson(manifest, (value) => withTarballs(value, tarballs));
  npmInstall(project, env);
  console.log('== portal: type-checking its pages');
  installTypecheckPackages(project, env);
  checkProjectTypes(project, env);

  const steps = ciRunSteps(readFileSync(path.join(project, APP_CI_WORKFLOW), 'utf8'));
  const [install, imports, packages, ...rest] = steps;
  if (install !== 'npm ci' || imports === undefined || packages === undefined || rest.length > 0) {
    throw new Error(
      `${APP_CI_WORKFLOW} has other steps than install, imports, packages: ${JSON.stringify(steps)}`,
    );
  }
  console.log(`== portal: ${APP_CI_WORKFLOW}, as generated`);
  for (const step of [imports, packages]) {
    const result = shell(step, project, env);
    if (result.status !== 0)
      throw new Error(`${step} exited ${String(result.status)}:\n${result.output}`);
  }

  console.log("== portal: a planted import '@agent-workspace/core' fails the import check");
  const planted = path.join(project, 'app/planted.ts');
  writeFileSync(planted, "import '@agent-workspace/core';\n");
  const refusedImport = shell(imports, project, env);
  rmSync(planted);
  if (
    refusedImport.status === 0 ||
    !refusedImport.output.includes('app-imports-only-published-packages')
  ) {
    throw new Error(`the planted import passed the import check:\n${refusedImport.output}`);
  }

  console.log('== portal: a planted @agent-workspace/core dependency fails the package check');
  const original = readFileSync(manifest, 'utf8');
  editJson(manifest, (value) => ({
    ...value,
    dependencies: {
      .../** @type {Record<string, string>} */ (value['dependencies']),
      '@agent-workspace/core': '0.0.0',
    },
  }));
  const refusedPackage = shell(packages, project, env);
  writeFileSync(manifest, original);
  if (refusedPackage.status === 0 || !refusedPackage.output.includes('@agent-workspace/core')) {
    throw new Error(`the planted dependency passed the package check:\n${refusedPackage.output}`);
  }
  console.log('== portal: generated CI passes, and refuses each planted reach');
  return project;
}

/**
 * The preset cases (issue #1511): each `--template` preset, created in the directory its reference
 * app uses, so the app is named after the directory and never the template id.
 */
export const TEMPLATE_CASES = Object.freeze({
  'team-chat': 'chat',
  wiki: 'wiki',
  crm: 'crm',
  'service-desk': 'desk',
});

/**
 * The follow-up commands a preset's README lists: every line that starts `npx aw `, in order, as
 * `sh` runs them.
 *
 * @param {string} readme
 */
export function readmeCommands(readme) {
  return readme.split('\n').filter((line) => line.startsWith('npx aw '));
}

/** @param {NodeJS.ProcessEnv} env */
const buildEnv = (env) => ({ ...env, NEXT_TELEMETRY_DISABLED: '1' });

/**
 * A preset case: `create <dir> --template <id> --yes` on the tarballs, `npx tsc --noEmit` and
 * `next build` before any of the README's commands has run. For `crm`, every command of its README
 * (the reference app's `commands.sh` after `npm create`) then runs without a path conflict, and the
 * app type-checks again.
 *
 * @param {{work: string, create: string, tarballs: Record<string, string>, env: NodeJS.ProcessEnv}} options
 * @param {keyof typeof TEMPLATE_CASES} directory
 */
export function templateCase({ work, create, tarballs, env }, directory) {
  const template = TEMPLATE_CASES[directory];
  console.log(`== ${directory}: create --template ${template}`);
  run(process.execPath, [create, directory, '--template', template, '--yes', '--no-install'], {
    cwd: work,
    env,
  });
  const project = path.join(work, directory);
  const recorded = readFileSync(path.join(project, 'aw-generated.json'), 'utf8');
  for (const key of [`app:${directory}`, `project:${directory}`]) {
    if (!recorded.includes(`"${key}"`)) throw new Error(`aw-generated.json records no ${key}`);
  }
  editJson(path.join(project, 'package.json'), (value) => withTarballs(value, tarballs));
  npmInstall(project, env);
  installTypecheckPackages(project, env);
  console.log(`== ${directory}: type-checking and building it as created`);
  checkProjectTypes(project, env);
  run('npx', ['--no-install', 'next', 'build'], {
    cwd: project,
    env: buildEnv(env),
    timeoutMs: 900_000,
  });
  if (template === 'crm') {
    const commands = readmeCommands(readFileSync(path.join(project, 'README.md'), 'utf8'));
    if (commands.length === 0) throw new Error('the crm README lists no npx aw commands');
    for (const command of commands) {
      console.log(`== ${directory}: ${command}`);
      const result = shell(command, project, env);
      if (result.status !== 0)
        throw new Error(`${command} exited ${String(result.status)}:\n${result.output}`);
    }
    checkProjectTypes(project, env);
  }
  console.log(`== ${directory} case passed`);
  return project;
}

/** @param {{work: string, create: string, tarballs: Record<string, string>, env: NodeJS.ProcessEnv}} options */
export function createDeskProject({ work, create, tarballs, env }) {
  console.log('== generating the project, its app, a resource and an agent');
  run(process.execPath, [create, PROJECT_NAME, '--yes', '--no-install', '--no-start'], {
    cwd: work,
    env,
  });
  const project = path.join(work, PROJECT_NAME);
  const manifest = path.join(project, 'package.json');
  editJson(manifest, (value) => withTarballs(value, tarballs));
  npmInstall(project, env);
  const aw = path.join(project, 'node_modules/@indx-workspace/aw/dist/index.js');
  run(process.execPath, [aw, 'generate', 'app', APP_NAME], { cwd: project, env });
  editJson(manifest, (value) => withTarballs(value, tarballs));
  npmInstall(project, env);
  run(
    process.execPath,
    [aw, 'generate', 'resource', 'ticket', 'title:text', 'status:enum(new,closed)'],
    {
      cwd: project,
      env,
    },
  );
  const resourceFile = path.join(project, 'resources/ticket.ts');
  writeFileSync(resourceFile, withAgentWrite(readFileSync(resourceFile, 'utf8')));
  run(process.execPath, [aw, 'generate', 'agent', 'triage', '--tools', 'ticket'], {
    cwd: project,
    env,
  });
  // Both agents (create's `assistant` and the generated `triage`) on the scripted model.
  for (const name of ['assistant', 'triage']) {
    const agentFile = path.join(project, 'agents', `${name}.ts`);
    writeFileSync(
      agentFile,
      withModel(readFileSync(agentFile, 'utf8'), `scripted:${SCRIPTED_MODEL}`),
    );
  }
  console.log('== type-checking the generated app');
  // `aw generate app` pins no TypeScript (`next dev` would install it on its first start), so the
  // developer's type check installs the versions this repository builds the app kit with.
  installTypecheckPackages(project, env);
  checkProjectTypes(project, env);
  // Planted after the developer's type check: the E2E's own route, never a generated file.
  mkdirSync(path.dirname(path.join(project, SIGN_IN_PROOF_ROUTE)), { recursive: true });
  writeFileSync(path.join(project, SIGN_IN_PROOF_ROUTE), signInProofRoute());

  return { project, manifest, aw };
}

/** @param {string} project */
export function readBootstrapAdmin(project) {
  const secrets = JSON.parse(
    readFileSync(path.join(project, '.agent-workspace/secrets/local-secrets.json'), 'utf8'),
  );
  const email = /bootstrapAdmin: (\S+)/u.exec(
    readFileSync(path.join(project, 'agent-workspace.yaml'), 'utf8'),
  )?.[1];
  return { email, password: secrets.BOOTSTRAP_ADMIN_PASSWORD };
}
