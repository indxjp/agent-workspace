import { describe } from 'vitest';
import './workspace-lifecycle.delivery.test-support';
import './workspace-lifecycle.hydration.test-support';
import './workspace-lifecycle.input-contract.test-support';
import { registerOutputContracts } from './workspace-lifecycle.output-contract.test-support';
import './workspace-lifecycle.output-key.test-support';
import './workspace-lifecycle.promotion.test-support';

describe('[US-STO-07][api][run] runtime output persistence', registerOutputContracts);
