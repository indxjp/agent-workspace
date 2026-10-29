import { describe, expect, it } from 'vitest';

import { fileStatuses } from './files.js';
import { sessionStateBlobStatuses } from './session-state-blobs.js';

describe('session_state_blobs statuses', () => {
  it('are their own list, so a new file status does not widen session_state_blobs_status_valid', () => {
    expect(sessionStateBlobStatuses).toEqual(['pending', 'ready', 'deleting']);
    expect(sessionStateBlobStatuses).not.toBe(fileStatuses);
  });
});
