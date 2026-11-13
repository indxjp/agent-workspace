import { describe } from 'vitest';
import { registerPointerMaterializationTests } from './pointers.materialization.test-support';
import { registerPointerConnectorPolicyTests } from './pointers.connectorpolicy.test-support';
import { registerPointerRefusalsTests } from './pointers.refusals.test-support';
import { registerPointerReferenceRacesTests } from './pointers.referenceraces.test-support';
import { registerPointerAuditingTests } from './pointers.auditing.test-support';
describe('setAgentPointer', () => {
  registerPointerMaterializationTests();
  registerPointerConnectorPolicyTests();
  registerPointerRefusalsTests();
  registerPointerReferenceRacesTests();
  registerPointerAuditingTests();
});
