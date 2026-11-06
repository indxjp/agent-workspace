import { describe, it } from 'vitest';

import { memoryPageStoreOf } from './memory-page-store.js';
import { describePageStoreConformance } from './page-conformance.js';

describePageStoreConformance(
  'memoryPageStoreOf conforms to the PageStore port',
  (resource, options) => {
    const store = memoryPageStoreOf(resource, { now: options.now });
    return { store, storedRevisions: (pageId) => Promise.resolve(store.storedRevisions(pageId)) };
  },
  { describe, it },
);
