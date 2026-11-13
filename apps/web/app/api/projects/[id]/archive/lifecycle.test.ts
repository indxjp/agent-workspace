import { describe } from 'vitest';
import { createScopedFixture } from './project-lifecycle.test-support';
import { registerAuthorizationTests } from './project-lifecycle.authorization.test-support';
import { registerAuditTests } from './project-lifecycle.audit.test-support';
import { registerHistoryTests } from './project-lifecycle.history.test-support';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn(
    '[app/api/projects/[id]/archive/lifecycle.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so ' +
      'the archive/restore routes were NOT exercised against a real database.',
  );
}

describe.skipIf(!hasDatabase)(
  'POST /api/projects/:id/archive and /restore (issue #183, PostgreSQL-backed)',
  () => {
    const fixture = createScopedFixture();
    registerAuthorizationTests(fixture);
    registerAuditTests(fixture);
    registerHistoryTests(fixture);
  },
);
