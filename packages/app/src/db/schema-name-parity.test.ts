import { appSchemaName as deployedSchemaName } from '@indx-workspace/contracts/project-file';
import { describe, expect, it } from 'vitest';

import { appSchemaName } from './schema-name.js';

// Issue #1512: `aw deploy` names an app's production schema and database role from the contracts
// `appSchemaName`, and `migrateApp` creates the schema from the app kit's. They must agree, or
// the app would migrate into a schema its role does not own.
describe('appSchemaName parity with the project file (#1512)', () => {
  it.each(['desk', 'service-desk', 'a', 'crm-2', 'x-y-z', 'a'.repeat(59)])(
    'derives the same schema for %s',
    (name) => {
      expect(appSchemaName(name)).toBe(deployedSchemaName(name));
    },
  );
});
