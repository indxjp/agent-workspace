import './skill-routes.configuration.test-support';
import './skill-routes.content-validation.test-support';
import './skill-routes.listing.test-support';
import './skill-routes.import.test-support';
import './skill-routes.publishing.test-support';
import './skill-routes.export.test-support';
import { registerOwnershipTests } from './skill-routes.ownership.test-support';

registerOwnershipTests(Boolean(process.env['TEST_DATABASE_URL']?.trim()));
