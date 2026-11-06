import { defineReferences } from '../tenancy-references.test-support.js';
import { defineProceduralCases } from '../tenancy-procedural-cases.test-support.js';
import { defineInventoryCases } from '../tenancy-inventory-cases.test-support.js';
import { defineIsolationCases } from '../tenancy-isolation-cases.test-support.js';
import { defineReferenceCases } from '../tenancy-reference-cases.test-support.js';

defineReferences();
defineProceduralCases();
defineInventoryCases();
defineIsolationCases();
defineReferenceCases();
