import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { PLATFORM_URL, appUrl, appSchema } from './lane-config.mjs';

/**
 * An app's `agent-workspace.yaml` with a `production` environment on `target` whose `apps` run
 * each app of `apps` (name to image) at {@link appUrl}. The generated file's last block is
 * `environments:`, so the new environment is indented under it; anything else is refused rather
 * than misplaced.
 *
 * @param {string} projectYaml @param {Readonly<Record<string, string>>} apps
 * @param {'single-vm' | 'kubernetes'} target
 */
export function withProductionApps(projectYaml, apps, target) {
  const lines = projectYaml.trimEnd().split('\n');
  const topLevel = lines.filter((line) => /^[a-zA-Z]/u.test(line));
  if (topLevel.at(-1) !== 'environments:') {
    throw new Error('agent-workspace.yaml does not end with its environments block');
  }
  if (/^ {2}production:/mu.test(projectYaml)) {
    throw new Error('agent-workspace.yaml has a production environment already');
  }
  const appLines = Object.entries(apps).flatMap(([name, image]) => [
    `      ${name}:`,
    `        image: ${image}`,
    `        url: ${appUrl(name)}`,
  ]);
  return [
    ...lines,
    '  production:',
    `    target: ${target}`,
    `    url: ${PLATFORM_URL}`,
    '    apps:',
    ...appLines,
    '',
  ].join('\n');
}

/**
 * A digest reference for an app whose image did not build, so the rendering is still checked: the
 * sha256 of its name, which names no real image.
 *
 * @param {string} name
 */
export function standInImage(name) {
  const digest = createHash('sha256').update(`apps-lane-${name}`).digest('hex');
  return `registry.apps-lane.test/${name}@sha256:${digest}`;
}

/**
 * Why the rendered `compose.apps.yaml` (parsed) does not run app `name` from `image` on its own
 * role; `undefined` when it does.
 *
 * @param {unknown} compose @param {string} name @param {string} image
 */
export function composeAppsProblem(compose, name, image) {
  const service = compose?.services?.[`app-${name}`];
  if (service === undefined) return `compose.apps.yaml has no app-${name} service`;
  if (service.image !== image) return `app-${name} runs ${String(service.image)}, not ${image}`;
  const url = String(service.environment?.DATABASE_URL ?? '');
  if (!url.startsWith(`postgres://${appSchema(name)}:`)) {
    return `app-${name}'s DATABASE_URL is not for the role ${appSchema(name)}`;
  }
  if (compose.services[`app-${name}-role`] === undefined) {
    return `compose.apps.yaml has no app-${name}-role service creating ${appSchema(name)}`;
  }
  return undefined;
}

/**
 * Why the rendered Helm values (parsed) do not list app `name` with `image` and its schema;
 * `undefined` when they do.
 *
 * @param {unknown} values @param {string} name @param {string} image
 */
export function helmAppsProblem(values, name, image) {
  const app = (values?.apps ?? []).find((entry) => entry?.name === name);
  if (app === undefined) return `the Helm values list no app ${name}`;
  if (app.image !== image) return `the Helm values run ${String(app.image)}, not ${image}`;
  if (app.schema !== appSchema(name)) {
    return `the Helm values give ${name} the schema ${String(app.schema)}`;
  }
  return app.host === new URL(appUrl(name)).hostname
    ? undefined
    : `the Helm values serve ${name} at ${String(app.host)}`;
}
