'use client';

/**
 * The "Archived" badge and Restore button on the agent page (issue #1851, slice 4). The notice sits
 * above the tabs so every tab shows it; after a restore the page refreshes its server data, so the
 * pointer controls and tabs reload.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { AgentResource, AgentRestoreCapability } from '../../contracts/agents';
import { browserClient } from '../../lib/browser-client';
import { getAgent, restoreAgent } from './agent-requests-model';
import type { RequestProblem } from './model';
import { BUTTON } from './table-styles';
import { restoreProblemText, versionsStrings, type VersionsLocale } from './versions-messages';

/**
 * May this viewer restore this agent? The comparison `POST /api/agents/:id/restore` itself makes:
 * whose agent is it, which of the server's two answers applies, and a built-in agent is refused
 * first. No role is named here (issue #184); the grants come from `decide()` on the server.
 */
function canRestoreAgent(capability: AgentRestoreCapability, agent: AgentResource): boolean {
  if (agent.archivedAt === undefined || agent.builtin !== undefined) return false;
  if (capability.viewerPrincipalId === null) return false;
  return agent.ownerPrincipalId === capability.viewerPrincipalId
    ? capability.canRestoreOwn
    : capability.canRestoreOther;
}

/** The "Archived" pill; hovering it shows when the agent was archived. */
export function ArchivedBadge({
  archivedAt,
  locale,
}: Readonly<{ archivedAt: string; locale: VersionsLocale }>) {
  const strings = versionsStrings(locale);
  return (
    <span
      lang={locale}
      title={strings.archivedTitle(archivedAt)}
      className="ml-2 rounded-full border border-border-strong bg-surface px-2 py-0.5 text-[11px] font-medium text-muted"
    >
      {strings.archivedBadge}
    </span>
  );
}

export function ArchivedNotice({
  agent,
  capability,
  locale,
  restoring,
  problem,
  onRestore,
}: Readonly<{
  agent: AgentResource;
  capability: AgentRestoreCapability;
  locale: VersionsLocale;
  restoring: boolean;
  problem: RequestProblem | null;
  onRestore: () => void;
}>) {
  if (agent.archivedAt === undefined) return null;
  const strings = versionsStrings(locale);
  return (
    <div className="flex flex-wrap items-center gap-3 px-8 pt-[26px]">
      <ArchivedBadge archivedAt={agent.archivedAt} locale={locale} />
      {canRestoreAgent(capability, agent) ? (
        <button type="button" className={BUTTON} disabled={restoring} onClick={onRestore}>
          {restoring ? strings.restoring : strings.restore}
        </button>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="text-[13px] text-danger">
          {restoreProblemText(problem.kind === 'api' ? problem : {}, strings)}
        </p>
      )}
    </div>
  );
}

export function AgentArchivedNotice({
  agentId,
  locale,
  capability,
}: Readonly<{ agentId: string; locale: VersionsLocale; capability: AgentRestoreCapability }>) {
  const router = useRouter();
  const [agent, setAgent] = useState<AgentResource | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [problem, setProblem] = useState<RequestProblem | null>(null);

  useEffect(() => {
    let active = true;
    // A failed read shows nothing here: the tab below reports the same failure in its own words.
    void getAgent(browserClient(), agentId).then((result) => {
      if (active && result.ok) setAgent(result.value);
    });
    return () => {
      active = false;
    };
  }, [agentId]);

  async function restore(): Promise<void> {
    setRestoring(true);
    setProblem(null);
    const result = await restoreAgent(browserClient(), agentId);
    if (result.ok) {
      setAgent(result.value);
      // Reload the server data too: the other tabs and the pointer controls were rendered while the
      // agent was frozen.
      router.refresh();
    } else setProblem(result.problem);
    setRestoring(false);
  }

  if (agent === null) return null;
  return (
    <ArchivedNotice
      agent={agent}
      capability={capability}
      locale={locale}
      restoring={restoring}
      problem={problem}
      onRestore={() => {
        void restore();
      }}
    />
  );
}
