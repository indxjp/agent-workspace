/**
 * Every example app under `examples/`, in the order its benchmark declares.
 *
 * An app's `benchmark.ts` imports nothing (a relative import of this harness would itself reach
 * outside the app and break its No fork cell), so each is wrapped in {@link defineAppBenchmark}
 * here, which type-checks it. The benchmarks are imported statically: the repository's
 * import-boundary gate (`tests/no-sdk-import.test.ts`) refuses a computed `import()`.
 * `benchmark.test.ts` checks that this list and the directories under `examples/` that hold a
 * `benchmark.ts` are the same, so an app added without registering it here fails there.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import crm from '../../examples/crm/benchmark.ts';
import minimal from '../../examples/minimal/benchmark.ts';
import serviceDesk from '../../examples/service-desk/benchmark.ts';
import teamChat from '../../examples/team-chat/benchmark.ts';
import wiki from '../../examples/wiki/benchmark.ts';
import { defineAppBenchmark, type AppBenchmark } from './benchmark.ts';

export const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
export const EXAMPLES_DIR = path.join(REPOSITORY_ROOT, 'examples');

const BENCHMARKS: readonly AppBenchmark[] = [
  defineAppBenchmark(minimal),
  defineAppBenchmark(teamChat),
  defineAppBenchmark(wiki),
  defineAppBenchmark(crm),
  defineAppBenchmark(serviceDesk),
];

/** One registered app: its directory and its benchmark. */
export interface ExampleApp {
  readonly dir: string;
  readonly benchmark: AppBenchmark;
}

export function loadExampleApps(): ExampleApp[] {
  return [...BENCHMARKS]
    .sort((left, right) => left.order - right.order)
    .map((benchmark) => ({ dir: path.join(EXAMPLES_DIR, benchmark.id), benchmark }));
}
