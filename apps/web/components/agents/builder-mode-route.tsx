'use client';

import { NewAgentScreen } from './agent-form';
import { BuilderMode } from './builder-mode';

/** `/agents/new`: the form screen with the Builder chat mounted, joined here so neither imports the other. */
export function NewAgentRoute() {
  return <NewAgentScreen chat={(modeSwitch) => <BuilderMode modeSwitch={modeSwitch} />} />;
}
