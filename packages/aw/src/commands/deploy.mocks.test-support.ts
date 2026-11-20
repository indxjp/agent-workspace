import type {
  DeployProjectEnvironmentOptions,
  DeployStatusOptions,
  DeployStatusReport,
  DestroyProjectEnvironmentOptions,
  ProjectDeployOutcome,
  ShowOwnerPasswordOptions,
} from '@indx-workspace/cli/deploy';
import { vi } from 'vitest';

/** The `@indx-workspace/cli/deploy` doubles every `aw deploy` test file mocks the module with. */
export const deployMocks = {
  deployProjectEnvironment:
    vi.fn<(options: DeployProjectEnvironmentOptions) => Promise<ProjectDeployOutcome>>(),
  showOwnerPassword: vi.fn<(options: ShowOwnerPasswordOptions) => Promise<string>>(),
  destroyProjectEnvironment: vi.fn<(options: DestroyProjectEnvironmentOptions) => Promise<void>>(),
  deployStatus: vi.fn<(options: DeployStatusOptions) => Promise<DeployStatusReport>>(),
};
