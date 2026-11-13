import { afterAll, beforeAll, describe } from 'vitest';

import {
  createConnectorStoreFixture,
  type ConnectorStoreFixture,
} from './store.fixture.test-support';
import { registerConnectorCredentialsTests } from './store.credentials.test-support';
import { registerConnectorToolsTests } from './store.tools.test-support';
import { registerConnectorIdentityTests } from './store.identity.test-support';
const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';
if (!hasDatabase) {
  console.warn(
    '[server/connectors/store.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the DB-backed ' +
      "connectors store — and this task's proof that a credential is stored as a secret " +
      'reference, never a raw value — was NOT exercised. A green result without it says nothing.',
  );
}
describe.skipIf(!hasDatabase)(
  'createRepositoryConnectorsStoreProvider against real PostgreSQL',
  () => {
    let fixture: ConnectorStoreFixture;
    beforeAll(async () => {
      fixture = await createConnectorStoreFixture(process.env);
    }, 180_000);
    afterAll(async () => {
      await fixture.secretsService.close();
      await fixture.isolated.close();
    });
    registerConnectorCredentialsTests(() => fixture);
    registerConnectorToolsTests(() => fixture);
    registerConnectorIdentityTests(() => fixture);
  },
);
