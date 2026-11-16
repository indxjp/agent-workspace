import { registerAuthenticationTests } from './session-api.authentication.test-support';
import { registerAppendTests } from './session-api.append.test-support';
import { registerTranscriptTests } from './session-api.transcript.test-support';
import { registerEngineStateTests } from './session-api.engine-state.test-support';
import { registerLifecycleTests } from './session-api.lifecycle.test-support';
import { registerPaginationTests } from './session-api.pagination.test-support';

registerAuthenticationTests();
registerAppendTests();
registerTranscriptTests();
registerEngineStateTests();
registerLifecycleTests();
registerPaginationTests();
