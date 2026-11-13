/**
 * `McpServerRepository` against a real PostgreSQL — the conformance suite `./mcp-servers.ts`'s
 * header promises. Copies `./root.test.ts`'s isolated-database shape.
 *
 * A real `secrets` row is inserted through `@agent-workspace/core/secrets`'s own
 * `createSecretsService`, against the SAME database, rather than by hand-crafting envelope bytes —
 * this suite is about the connector row's shape, not about re-testing envelope encryption, and a
 * hand-rolled envelope would drift from what `secrets_wrapped_data_key_size` etc. actually require.
 */
import { describe } from 'vitest';

import { registerCrudCases } from './mcp-servers.crud.test-support.js';
import { createMcpServerFixture } from './mcp-servers.fixture.test-support.js';
import { registerConnectorKindsCases } from './mcp-servers.kinds.test-support.js';
import { registerSecretReferenceCases } from './mcp-servers.secret-references.test-support.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[repositories/mcp-servers.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the connector ' +
      'repository was NOT exercised against a real PostgreSQL. A green result without it says ' +
      'nothing about McpServerRepository.',
  );
}

describe.skipIf(!hasDatabase)('McpServerRepository against real PostgreSQL', () => {
  const fixture = createMcpServerFixture();
  registerCrudCases(fixture);
  registerSecretReferenceCases(fixture);
  registerConnectorKindsCases(fixture);
});
