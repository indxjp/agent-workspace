import {
  createDatabaseLoginTokenRepository,
  createIsolatedTestDatabase,
  loginTokens,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll } from 'vitest';

import { describeLoginTokenStoreConformance } from './login-tokens.contract';
import { MemoryLoginTokenStore } from './memory';
import { createLoginTokenStore } from './store';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describeLoginTokenStoreConformance('the memory adapter', () =>
  Promise.resolve(new MemoryLoginTokenStore()),
);

if (hasDatabase) {
  let isolated: IsolatedTestDatabase;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_login_tokens_store');
  });
  afterAll(async () => {
    await isolated.close();
  });

  describeLoginTokenStoreConformance('the PostgreSQL adapter', async () => {
    await isolated.db.delete(loginTokens);
    return createLoginTokenStore(createDatabaseLoginTokenRepository(isolated.db));
  });
}
