'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { browserClient } from '../../lib/browser-client';
import type { Speaker } from '@indx-workspace/react/run-model';
import type { ModelSelectionValue } from '../models/catalog';
import { modelsDrivableBy } from '../models/engine-models';
import { useModelCatalog } from '../models/model-selector';
import { useComposerPrefill } from '../run/run-view';
import type { OpenPicker } from './home-chat-controls';
import type { HomeChatProps } from './home-chat-types';
import {
  findAgent,
  initialSession,
  lastAgentStorageKey,
  preferredAgent,
  selectAgent,
  startSession,
  toggleOption,
  type ComposerAgent,
  type ComposerProject,
  type ComposerSession,
  type PickerKind,
} from './model';

function openingSession(
  list: readonly ComposerAgent[],
  locked: HomeChatProps['agent'],
  setupAgentId: string | null,
): ComposerSession | null {
  if (locked === undefined) return initialSession(list, null, setupAgentId);
  const found = findAgent(list, locked.id);
  return found === null ? null : startSession(found, 0);
}

/** The key the last-used agent is remembered under, or `null` when nothing is remembered. */
export function rememberedAgentKey(
  locked: boolean,
  user: Speaker | null,
  viewer: { readonly workspaceId: string; readonly userId: string } | null,
): string | null {
  return locked || user === null || viewer === null
    ? null
    : lastAgentStorageKey(viewer.workspaceId, viewer.userId);
}

/** Remembering the agent is a convenience; a browser that refuses storage still sends. */
export function rememberAgent(rememberedKey: string | null, agentId: string): void {
  if (rememberedKey === null) return;
  try {
    window.localStorage.setItem(rememberedKey, agentId);
  } catch {
    // Storage refused: the agent is simply not remembered.
  }
}

function readRememberedAgent(rememberedKey: string): string | null | undefined {
  try {
    return window.localStorage.getItem(rememberedKey);
  } catch {
    return undefined;
  }
}

/** The chat's session: opened on the first agent, then moved to the remembered one on mount. */
export function useAgentSession(
  list: readonly ComposerAgent[],
  lockedAgent: HomeChatProps['agent'],
  setupAgentId: string | null,
  rememberedKey: string | null,
) {
  const [session, setSession] = useState<ComposerSession | null>(() =>
    openingSession(list, lockedAgent, setupAgentId),
  );

  useEffect(() => {
    if (rememberedKey === null) return;
    const remembered = readRememberedAgent(rememberedKey);
    if (remembered === undefined) return;
    const chosen = preferredAgent(list, remembered, setupAgentId);
    setSession((current) =>
      current === null || current.key !== 0 || chosen === null || chosen.id === current.agentId
        ? current
        : startSession(chosen, 1),
    );
  }, [list, rememberedKey, setupAgentId]);

  const switchAgent = useCallback(
    (agentId: string) => {
      setSession((current) => {
        if (current === null) return current;
        const update = selectAgent(list, current, agentId);
        // A refused switch leaves the session exactly as it was. `selectAgent` names the reason
        // rather than returning the input, so this branch is a decision and not a fallthrough.
        return update.ok ? update.session : current;
      });
    },
    [list],
  );

  const toggle = useCallback(
    (kind: PickerKind, optionId: string) => {
      setSession((current) => {
        if (current === null) return current;
        const on = findAgent(list, current.agentId);
        if (on === null) return current;
        const update = toggleOption(on, current, kind, optionId);
        return update.ok ? update.session : current;
      });
    },
    [list],
  );

  return { session, switchAgent, toggle };
}

/** The projects the signed-in person can start a chat in, and the one picked. */
export function useComposerProjects(): {
  readonly projects: readonly ComposerProject[];
  readonly projectId: string | null;
  readonly setProjectId: Dispatch<SetStateAction<string | null>>;
} {
  const [projects, setProjects] = useState<readonly ComposerProject[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void browserClient()
      .projects.list()
      .then((found) => {
        if (active) setProjects(found.map(({ id, name }) => ({ id, name })));
      })
      .catch(() => {
        if (active) setProjects([]);
      });
    return () => {
      active = false;
    };
  }, []);

  return { projects, projectId, setProjectId };
}

/** The open picker; a click anywhere outside a `[data-picker]` closes it. */
export function useOpenPicker(): readonly [OpenPicker, Dispatch<SetStateAction<OpenPicker>>] {
  const [open, setOpen] = useState<OpenPicker>(null);

  useEffect(() => {
    if (open === null) return undefined;
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      const inside = target instanceof Element && target.closest('[data-picker]') !== null;
      if (!inside) setOpen(null);
    };
    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, [open]);

  return [open, setOpen];
}

/** The agents the screen offers, with the setup agent and viewer that came with them. */
export function agentRoster(agents: HomeChatProps['agents']) {
  if (agents.kind === 'no-agents') {
    return { list: [], setupAgentId: null, viewer: null, notice: agents.reason };
  }
  return {
    list: agents.agents,
    setupAgentId: agents.setupAgentId ?? null,
    viewer: agents.viewer ?? null,
    notice: '',
  };
}

/** The composer text, which a prefill sets and focuses. */
export function useComposerDraft(prefill: HomeChatProps['prefill']) {
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useComposerPrefill(prefill, setDraft, composerRef);
  return { draft, setDraft, composerRef };
}

/** The models the agent can be driven with, and the entry the per-run override names, if any. */
export function useModelChoices(agent: ComposerAgent | null, modelOverride: ModelSelectionValue) {
  const catalogState = useModelCatalog();
  const catalog = catalogState.kind === 'ready' ? catalogState.catalog : null;
  const drivableModels =
    agent === null ? [] : modelsDrivableBy(agent.drivableProviders, catalog?.models ?? []);
  const overrideEntry =
    modelOverride === null
      ? undefined
      : drivableModels.find(
          (entry) =>
            entry.connectionId === modelOverride.connectionId &&
            entry.providerModelId === modelOverride.model,
        );
  return { drivableModels, overrideEntry, catalogUnavailable: catalog?.unavailable ?? [] };
}
