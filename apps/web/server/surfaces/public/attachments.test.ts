import { createInMemoryObjectStoreProvider } from '@agent-workspace/core/storage';
import { beforeAll, beforeEach, describe } from 'vitest';
import {
  startAttachmentDatabase,
  createAttachmentHarness,
  memoryWorld,
  postgresWorld,
  type AttachmentHarness,
} from './attachments.fixture.test-support';
import { registerAttachmentSavingTests } from './attachments.saving.test-support';
import { registerAttachmentRunAccessTests } from './attachments.runaccess.test-support';
import { registerAttachmentValidationTests } from './attachments.validation.test-support';
import { registerAttachmentLimitsTests } from './attachments.limits.test-support';
import { registerAttachmentLifecycleTests } from './attachments.lifecycle.test-support';

function defineSuite(name: string, setup: typeof memoryWorld) {
  describe(`attachments on the ${name}`, () => {
    const legacy = createInMemoryObjectStoreProvider();
    let harness: AttachmentHarness;
    beforeEach(async () => {
      harness = createAttachmentHarness(await setup(), process.env, legacy);
    });
    registerAttachmentSavingTests(() => harness);
    registerAttachmentRunAccessTests(() => harness, setup);
    registerAttachmentValidationTests(() => harness);
    registerAttachmentLimitsTests(() => harness);
    registerAttachmentLifecycleTests(() => harness);
  });
}
defineSuite('in-memory catalog', memoryWorld);
defineSuite('PostgreSQL catalog', postgresWorld);

beforeAll(async () => {
  if (!process.env['TEST_DATABASE_URL']?.trim())
    throw new Error('TEST_DATABASE_URL is not set; run this suite through `pnpm test`.');
  await startAttachmentDatabase();
}, 180_000);
