/**
 * `DemoTemplates`, run against memory stores always and against a real PostgreSQL whenever
 * `TEST_DATABASE_URL` names one.
 */
import { afterAll, beforeAll, describe } from 'vitest';

import type { DemoSandbox } from './ports';
import { describeRecordedWrites } from './templates.recorded.test-support';
import { describeDemoTemplatesConformance, type DemoTemplatesWorld } from './templates.contract';
import {
  createMemoryTemplatesWorld,
  openPostgresTemplatesWorld,
} from './templates.world.test-support';

describeDemoTemplatesConformance('the memory world', (sandbox) =>
  Promise.resolve(createMemoryTemplatesWorld(sandbox)),
);
describeRecordedWrites(() => Promise.resolve(createMemoryTemplatesWorld()));

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('DemoTemplates over a real PostgreSQL', () => {
  let opened: Awaited<ReturnType<typeof openPostgresTemplatesWorld>>;

  beforeAll(async () => {
    opened = await openPostgresTemplatesWorld();
  }, 180_000);

  afterAll(async () => {
    await opened.close();
  });

  const world = (sandbox?: Partial<DemoSandbox>): Promise<DemoTemplatesWorld> =>
    opened.world(sandbox);
  describeDemoTemplatesConformance('the PostgreSQL world', world);
  describeRecordedWrites(world);
});
