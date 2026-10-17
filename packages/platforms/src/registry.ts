import type { PlatformId } from '@indx-workspace/contracts/platforms';

import type { PlatformTarget } from './port.js';
import { awsAgentCoreTarget } from './targets/aws-agentcore/index.js';
import { claudeManagedAgentsTarget } from './targets/claude-managed-agents/index.js';
import { copilotStudioTarget } from './targets/copilot-studio/index.js';
import { ejectClaudeAgentSdkTarget } from './targets/eject-claude-agent-sdk/index.js';
import { ejectMastraTarget } from './targets/eject-mastra/index.js';
import { ejectOpenAiAgentsTarget } from './targets/eject-openai-agents/index.js';
import { geminiEnterpriseTarget } from './targets/gemini-enterprise/index.js';
import { m365DeclarativeAgentTarget } from './targets/m365-declarative-agent/index.js';
import { microsoftFoundryTarget } from './targets/microsoft-foundry/index.js';

/** Every platform target this package ships, in PLATFORM_IDS order. P2–P8 each add one line. */
export const PLATFORM_TARGETS: readonly PlatformTarget[] = [
  claudeManagedAgentsTarget,
  copilotStudioTarget,
  m365DeclarativeAgentTarget,
  microsoftFoundryTarget,
  geminiEnterpriseTarget,
  awsAgentCoreTarget,
  ejectClaudeAgentSdkTarget,
  ejectMastraTarget,
  ejectOpenAiAgentsTarget,
];

export function platformTarget(id: PlatformId): PlatformTarget | undefined {
  return PLATFORM_TARGETS.find((target) => target.id === id);
}
