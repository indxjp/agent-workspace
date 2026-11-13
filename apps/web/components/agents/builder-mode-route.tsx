'use client';

import { useEffect, useState } from 'react';

import { browserClient } from '../../lib/browser-client';
import { NewAgentScreen } from './agent-form';
import { loadBuilderEnabled } from './agent-requests-model';
import { BuilderMode } from './builder-mode';
import type { VersionsLocale } from './versions-messages';

/**
 * `/agents/new`: the form screen with the Builder chat mounted, joined here so neither imports the
 * other. The Chat option follows the caller's `/api/me` `builder` feature, off until it is known.
 * `filesEnabled` is the workspace's Files switch, read by the server page; `locale` is the reader's
 * language (UX-15 in #2086), negotiated there from `Accept-Language`.
 */
export function NewAgentRoute({
  filesEnabled,
  locale = 'en',
}: Readonly<{ filesEnabled: boolean; locale?: VersionsLocale }>) {
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
      locale={locale}
      chat={(modeSwitch) => (
        <BuilderMode modeSwitch={modeSwitch} filesEnabled={filesEnabled} locale={locale} />
      )}
    />
  );
}
