import { describe } from 'vitest';
import {
  memoryFixture,
  postgresFixture,
  createUploadHarness,
  type Fixture,
} from './service-upload.fixture.test-support';
import { registerUploadCompletionTests } from './service-upload.completion.test-support';
import { registerUploadPendingLimitTests } from './service-upload.pendinglimit.test-support';
import { registerUploadAuthorizationTests } from './service-upload.authorization.test-support';
import { registerUploadRelayTests } from './service-upload.relay.test-support';
import { registerUploadVerificationTests } from './service-upload.verification.test-support';
function defineSuite(name: string, setup: () => Promise<Fixture>) {
  describe(`signed uploads through the service on the ${name}`, () => {
    const harness = (bindsLength = true) => createUploadHarness(setup, bindsLength);
    registerUploadCompletionTests(harness);
    registerUploadPendingLimitTests(harness);
    registerUploadAuthorizationTests(harness);
    registerUploadRelayTests(harness);
    registerUploadVerificationTests(harness);
  });
}
defineSuite('in-memory catalog', memoryFixture);
defineSuite('PostgreSQL catalog', postgresFixture);
