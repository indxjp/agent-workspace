import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { attempt, tail } from './lane-commands.mjs';
import {
  withProductionApps,
  standInImage,
  composeAppsProblem,
  helmAppsProblem,
} from './lane-deploy-checks.mjs';
import { appImage } from './lane-build-image.mjs';

export {
  withProductionApps,
  standInImage,
  composeAppsProblem,
  helmAppsProblem,
} from './lane-deploy-checks.mjs';

/** @param {{id: string, copy: string, image: string}} app @param {{work: string, target: 'single-vm' | 'kubernetes'}} destination */
function preparePlanProject({ id, copy, image }, { work, target }) {
  const home = path.join(work, 'deploy', `${id}-${target}`);
  const project = path.join(home, 'project');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  cpSync(copy, project, {
    recursive: true,
    filter: (source) =>
      !/(?:^|[\\/])(?:node_modules|\.next|\.agent-workspace|\.aw)(?:[\\/]|$)/u.test(source),
  });
  const projectFile = path.join(project, 'agent-workspace.yaml');
  writeFileSync(
    projectFile,
    withProductionApps(readFileSync(projectFile, 'utf8'), { [id]: image }, target),
  );
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  if (target === 'kubernetes') {
    writeFileSync(
      path.join(bin, 'helm'),
      '#!/bin/sh\n[ "$1" = version ] && echo v3.16.0-apps-lane\nexit 0\n',
    );
    chmodSync(path.join(bin, 'helm'), 0o755);
  }
  return { home, project, projectFile, bin };
}

/**
 * `aw deploy production`'s plan of the app copy at `target`, in a home of its own: the parsed
 * file `aw deploy` rendered (`compose.apps.yaml`, or the Helm values), or the reason it has none.
 * The Kubernetes plan runs with a `helm` that answers every call and does nothing (shortcut: the
 * lane checks the values `aw deploy` writes and installs no chart; upgrade when it has a cluster).
 *
 * @param {{ id: string, copy: string, image: string, env: NodeJS.ProcessEnv, work: string, target: 'single-vm' | 'kubernetes' }} options
 */
export function renderedPlan({ id, copy, image, env, work, target }) {
  const { home, project, projectFile, bin } = preparePlanProject(
    { id, copy, image },
    { work, target },
  );
  const aw = path.join(copy, 'node_modules/@indx-workspace/aw/dist/index.js');
  const planned = attempt(process.execPath, [aw, 'deploy', 'production'], {
    cwd: project,
    env: { ...env, HOME: home, PATH: `${bin}${path.delimiter}${env['PATH'] ?? ''}` },
    timeoutMs: 300_000,
  });
  // A plan with changes exits 3 (ADR-0094); 0 is a plan without.
  if (planned.status !== 0 && planned.status !== 3) {
    return {
      problem: `aw deploy production (${target}) exited ${String(planned.status)}:\n${tail(planned.output)}`,
    };
  }
  const state = path.join(
    home,
    '.config/agent-workspace/deployments',
    projectName(projectFile),
    'production',
  );
  const file =
    target === 'single-vm'
      ? path.join(state, 'compose.apps.yaml')
      : path.join(state, 'deploy/helm/values.yaml');
  if (!existsSync(file))
    return { problem: `aw deploy production (${target}) wrote no ${path.basename(file)}` };
  return { parsed: parsedYaml(copy, file), state };
}

/**
 * The YAML file `file`, parsed by the `yaml` package the app's own install holds (the repository
 * root declares none), in a child process run in the app copy.
 *
 * @param {string} copy @param {string} file
 */
function parsedYaml(copy, file) {
  const read = attempt(
    process.execPath,
    [
      '-e',
      "process.stdout.write(JSON.stringify(require('yaml').parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))))",
      file,
    ],
    { cwd: copy, timeoutMs: 60_000 },
  );
  if (read.status !== 0) throw new Error(`could not parse ${file}:\n${tail(read.output)}`);
  return JSON.parse(read.stdout);
}

/** The `name:` of a project file. @param {string} file */
function projectName(file) {
  const name = /^name: (\S+)$/mu.exec(readFileSync(file, 'utf8'))?.[1];
  if (name === undefined) throw new Error(`${file} has no name`);
  return name;
}

/**
 * The self-host step's per-app half: the image, then both plans with it (or, when it did not
 * build, with {@link standInImage}, so the rendering is still measured). `image` is set only when
 * the app's own image was built and both renderings name it.
 *
 * @param {{ id: string, copy: string, env: NodeJS.ProcessEnv, work: string, registry: ReturnType<typeof import('./lane-registry.mjs').laneRegistry>, packages: { url: string } }} options
 */
export function selfHostRender({ id, copy, env, work, registry, packages }) {
  const built = appImage({ id, env, work, registry, packages });
  const image = 'image' in built ? built.image : standInImage(id);
  const problems = 'problem' in built ? [built.problem] : [];
  const compose = renderedPlan({ id, copy, image, env, work, target: 'single-vm' });
  problems.push(
    ...('problem' in compose ? [compose.problem] : [composeAppsProblem(compose.parsed, id, image)]),
  );
  const helm = renderedPlan({ id, copy, image, env, work, target: 'kubernetes' });
  problems.push(
    ...('problem' in helm ? [helm.problem] : [helmAppsProblem(helm.parsed, id, image)]),
  );
  const found = problems.filter((problem) => problem !== undefined);
  return found.length === 0 ? { image } : { problem: found.join('\n') };
}
