'use client';

/** The new-agent form and its form/chat mode entry point. */

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { AgentPermissions } from '../../contracts/agents';
import { browserClient } from '../../lib/browser-client';
import { createAgent, loadNewAgentCatalogs } from './agent-requests-model';
import {
  buildCreateAgentInput,
  isValidAgentName,
  type AgentResourceOptions,
  type RequestProblem,
  type RuntimeProfileOption,
} from './model';
import { type ModelSelectionValue } from '../models/catalog';
import { useModelCatalog } from '../models/model-selector';
import { newAgentStrings, type NewAgentStrings } from './new-agent-messages';

export function useNewAgentForm(
  router: Pick<ReturnType<typeof useRouter>, 'push'>,
  words: Pick<NewAgentStrings, 'runtimesFailed'> = newAgentStrings('en'),
) {
  // A module constant per locale, so the effect below runs once.
  const { runtimesFailed } = words;
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<RequestProblem | null>(null);
  const [runtimeProfiles, setRuntimeProfiles] = useState<readonly RuntimeProfileOption[] | null>(
    null,
  );
  const catalogState = useModelCatalog();
  const [selectedRuntimeProfileId, setSelectedRuntimeProfileId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelSelectionValue>(null);
  const [autoSelected, setAutoSelected] = useState(false);
  const [resources, setResources] = useState<AgentResourceOptions | null>(null);
  const [fileAccess, setFileAccess] = useState<Record<string, 'read' | 'read-write'>>({});
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [selectedConnectors, setSelectedConnectors] = useState<Set<string>>(new Set());
  const [permissions, setPermissions] = useState<AgentPermissions>({
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  });

  useEffect(() => {
    let active = true;
    void loadNewAgentCatalogs(browserClient())
      .then(({ runtimeProfiles: profiles, resources: options }) => {
        if (!active) return;
        setRuntimeProfiles(profiles);
        setSelectedRuntimeProfileId(profiles[0]?.id ?? null);
        setResources(options);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRuntimeProfiles([]);
        setResources({ files: [], skills: [], connectors: [] });
        setProblem({
          kind: 'transport',
          reason: runtimesFailed(error instanceof Error ? error.message : String(error)),
        });
      });
    return () => {
      active = false;
    };
  }, [runtimesFailed]);

  const catalogModels = catalogState.kind === 'ready' ? catalogState.catalog.models : [];
  const catalogUnavailable = catalogState.kind === 'ready' ? catalogState.catalog.unavailable : [];
  // The first catalog model is pre-selected once, the same default `RuntimeProfileStep` applies —
  // a person who wants another model still has to click it, but the form does not open with
  // nothing chosen when at least one is available.
  useEffect(() => {
    const first = catalogModels[0];
    if (autoSelected || first === undefined) return;
    setAutoSelected(true);
    setSelectedModel({ connectionId: first.connectionId, model: first.providerModelId });
  }, [autoSelected, catalogModels]);

  const canSubmit =
    isValidAgentName(name) &&
    selectedRuntimeProfileId !== null &&
    selectedModel !== null &&
    !submitting;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || selectedRuntimeProfileId === null || selectedModel === null) return;
    setSubmitting(true);
    setProblem(null);

    void createAgent(
      browserClient(),
      buildCreateAgentInput(
        name,
        instructions,
        selectedRuntimeProfileId,
        selectedModel,
        permissions,
      ),
      {
        files: Object.entries(fileAccess).map(([fileId, access]) => ({ fileId, access })),
        skillIds: [...selectedSkills],
        connectorIds: [...selectedConnectors],
      },
    ).then((created) => {
      if (!created.ok) {
        setSubmitting(false);
        setProblem(created.problem);
        return;
      }
      router.push(`/agents/${created.value}`);
    });
  }

  return {
    name,
    setName,
    instructions,
    setInstructions,
    submitting,
    problem,
    runtimeProfiles,
    catalogState,
    selectedRuntimeProfileId,
    setSelectedRuntimeProfileId,
    selectedModel,
    setSelectedModel,
    resources,
    fileAccess,
    setFileAccess,
    selectedSkills,
    setSelectedSkills,
    selectedConnectors,
    setSelectedConnectors,
    permissions,
    setPermissions,
    catalogModels,
    catalogUnavailable,
    canSubmit,
    onSubmit,
  };
}
