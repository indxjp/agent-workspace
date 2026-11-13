import { describe } from 'vitest';

import { createModelHttpFixture } from './routes.fixture.test-support';
import { registerModelHttpLifecycleTests } from './routes.lifecycle.test-support';
import { registerModelHttpCredentialsTests } from './routes.credentials.test-support';
import { registerModelHttpConnectionsTests } from './routes.connections.test-support';
import { registerModelHttpAvailabilityTests } from './routes.availability.test-support';
describe('model connections HTTP surface', () => {
  const fixture = createModelHttpFixture();
  registerModelHttpLifecycleTests(() => fixture);
  registerModelHttpCredentialsTests();
  registerModelHttpConnectionsTests();
  registerModelHttpAvailabilityTests();
});
import { createModelAuthorizationFixture } from './routes.fixture.test-support';
import { registerModelAuthorizationRoleWritesTests } from './routes.rolewrites.test-support';
import { registerModelAuthorizationIsolationTests } from './routes.isolation.test-support';
describe('model connections write authorisation — issue #149', () => {
  const fixture = createModelAuthorizationFixture();
  registerModelAuthorizationRoleWritesTests(() => fixture);
  registerModelAuthorizationIsolationTests(() => fixture);
});
import { createModelCompositionFixture } from './routes.fixture.test-support';
import { registerModelCompositionActorRolesTests } from './routes.actorroles.test-support';
describe('installModelsApi composition root — issue #149', () => {
  createModelCompositionFixture();
  registerModelCompositionActorRolesTests();
});
import { createVertexCompositionFixture } from './routes.fixture.test-support';
import { registerVertexCompositionVertexIdentityTests } from './routes.vertexidentity.test-support';
describe('installModelsApi composition root — the install Vertex identity', () => {
  const fixture = createVertexCompositionFixture();
  registerVertexCompositionVertexIdentityTests(() => fixture);
});
