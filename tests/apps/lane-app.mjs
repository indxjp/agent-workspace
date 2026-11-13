import { record } from './lane-results.mjs';
import path from 'node:path';
import { blockedReason } from './lane-results.mjs';
import {
  tail,
  stepOf,
  regenerateStep,
  installStep,
  testStep,
  depcruiseStep,
} from './lane-commands.mjs';
import { journeysStep } from './lane-journeys.mjs';
import { selfHostRender } from './lane-self-host.mjs';

/** The registered apps' benchmarks, read from each `examples/<id>/benchmark.ts`. */
export async function registeredApps() {
  const { loadExampleApps } = await import('./registry.ts');
  return loadExampleApps().map(
    (/** @type {import('./registry.js').ExampleApp} */ app) => app.benchmark,
  );
}

/** Every step of one app but the platform boot. */
export async function runApp({ benchmark, skip, work, tarballs, env, taken, registry, packages }) {
  const { id } = benchmark;
  const copy = path.join(work, 'apps', id);
  const outcomes = new Map();
  /** @type {string[]} */
  let unexcused = [];
  /** @type {(step: string, run: () => import('./lane.d.mts').StepOutcome | Promise<import('./lane.d.mts').StepOutcome>) => Promise<void>} */
  const step = async (name, run) => {
    const blocked = blockedReason(name, outcomes, skip);
    if (blocked !== undefined) {
      record(id, outcomes, name, { status: 'gap', reason: blocked });
      return;
    }
    try {
      record(id, outcomes, name, await run());
    } catch (error) {
      record(id, outcomes, name, { status: 'failed', reason: `threw: ${tail(String(error))}` });
    }
  };
  await step('regenerate', () => regenerateStep(id, work, tarballs, benchmark.takenOver ?? []));
  await step('install', () => installStep(id, copy, tarballs, env));
  await step('build', () =>
    stepOf('next build', 'npx', ['--no-install', 'next', 'build'], { cwd: copy, env }),
  );
  await step('test', () => testStep(benchmark, copy, work, env));
  await step('depcruise', () => depcruiseStep(copy, env));
  await step('journeys', async () => {
    const outcome = await journeysStep({ id, benchmark, copy, env, work, taken });
    unexcused = outcome.unexcused;
    return outcome;
  });
  /** @type {string | undefined} */
  let image;
  await step('self-host', () => {
    if (packages === undefined) return { status: 'gap', reason: 'Docker is not available' };
    const rendered = selfHostRender({ id, copy, env, work, registry, packages });
    if ('problem' in rendered) return { status: 'failed', reason: rendered.problem };
    image = rendered.image;
    return { status: 'ok', reason: 'rendered; the boot follows' };
  });
  return { benchmark, outcomes, unexcused, image, copy };
}
