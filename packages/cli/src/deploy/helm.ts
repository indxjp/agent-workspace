/**
 * `deploy` for a chart target: Helm (ADR-0094).
 *
 * With the helm-diff plugin the plan is `helm diff upgrade`, which compares with the release in
 * the cluster. Without it, `helm template` renders the manifests locally and `deploy` prints
 * which resources the release holds, not the manifests themselves; it cannot know what the
 * cluster has, so that plan always counts as a change.
 */
import { parseAllDocuments } from 'yaml';

import { runStep, type DeployContext, type DeployOutcome } from './steps.ts';
import { HELM_RELEASE, type DeployTarget } from './targets.ts';

type HelmTarget = Extract<DeployTarget, { kind: 'helm' }>;

/** True when `helm plugin list` names the `diff` plugin. */
export function hasDiffPlugin(pluginList: string): boolean {
  return pluginList
    .split(/\r?\n/u)
    .slice(1)
    .some((line) => line.trim().split(/\s+/u)[0] === 'diff');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `Kind/name` of every resource `helm template` rendered, in its order. */
export function summarizeManifests(manifests: string): readonly string[] {
  return parseAllDocuments(manifests).flatMap((document) => {
    const resource: unknown = document.toJS();
    if (!isRecord(resource)) return [];
    const { kind, metadata } = resource;
    const name = isRecord(metadata) ? metadata['name'] : undefined;
    return typeof kind === 'string' && typeof name === 'string' ? [`${kind}/${name}`] : [];
  });
}

export async function deployWithHelm(
  context: DeployContext,
  target: HelmTarget,
  apply: boolean,
): Promise<DeployOutcome> {
  const release = [
    HELM_RELEASE,
    target.chart,
    '--namespace',
    HELM_RELEASE,
    '-f',
    target.flavourFile,
    ...(target.operatorValuesFile === undefined ? [] : ['-f', target.operatorValuesFile]),
    '-f',
    target.overlayFile,
  ];
  const plugins = await runStep(context, 'helm', ['plugin', 'list'], { show: false });

  let changes: boolean;
  if (hasDiffPlugin(plugins.stdout)) {
    const diff = await runStep(
      context,
      'helm',
      ['diff', 'upgrade', ...release, '--allow-unreleased', '--detailed-exitcode'],
      { show: true, accept: [0, 2] },
    );
    changes = diff.status === 2;
  } else {
    const rendered = await runStep(context, 'helm', ['template', ...release], { show: false });
    const resources = summarizeManifests(rendered.stdout);
    context.out(
      `The chart renders ${String(resources.length)} resource(s):\n` +
        resources.map((resource) => `  ${resource}\n`).join('') +
        'Without the helm-diff plugin the release in the cluster cannot be compared, so this ' +
        'counts as a change. Install https://github.com/databus23/helm-diff for an exact plan.\n',
    );
    changes = true;
  }

  if (!apply || !changes) return { changes, applied: false };
  // A first install into a fresh cluster has no `agent-workspace` namespace yet.
  await runStep(
    context,
    'helm',
    ['upgrade', '--install', ...release, '--create-namespace', '--wait'],
    { show: true },
  );
  return { changes, applied: true };
}
