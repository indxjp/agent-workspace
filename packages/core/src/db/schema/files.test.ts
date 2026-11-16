import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { files } from './files.js';
import { sessionStateBlobs } from './session-state-blobs.js';

const dialect = new PgDialect();

describe('object_id', () => {
  // The storage design, §06: once the upgrade guard has proven the move off the old naming, every
  // stored object is named by its id. A folder has no object, so the files rule is per kind.
  it('object_id is required', () => {
    const check = getTableConfig(files).checks.find(
      (entry) => entry.name === 'files_file_has_object_id',
    );
    expect(check === undefined ? null : dialect.sqlToQuery(check.value).sql).toBe(
      `"files"."kind" <> 'file' or "files"."object_id" is not null`,
    );
    expect(sessionStateBlobs.objectId.notNull).toBe(true);
  });
});
