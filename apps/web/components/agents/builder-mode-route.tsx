'use client';

import { useEffect, useState } from 'react';

import { browserClient } from '../../lib/browser-client';
import { NewAgentScreen } from './agent-form';
import { loadBuilderEnabled } from './agent-requests-model';
import { BuilderMode } from './builder-mode';

/**
 * `/agents/new`: the form screen with the Builder chat mounted, joined here so neither imports the
 * other. The Chat option follows the caller's `/api/me` `builder` feature, off until it is known.
 */
export function NewAgentRoute() {
  const [builderOn, setBuilderOn] = useState(false);
  useEffect(() => {
    let active = true;
    void loadBuilderEnabled(browserClient()).then((on) => {
      if (active) setBuilderOn(on);
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <NewAgentScreen
      chatEnabled={builderOn}
      chat={(modeSwitch) => <BuilderMode modeSwitch={modeSwitch} />}
    />
  );
}
