import Link from 'next/link';
import { withSetupWizardLink } from '../setup/setup-wizard-link';
import { runTargetIn, runTargetLine, runTargetWarns } from './model';
import type { HomeChatProps } from './home-chat-types';
import type { ComposerStrings } from './composer-messages';
import type { useHomeChatState } from './use-home-chat';
import {
  Picker,
  PHEAD,
  OPT,
  PFOOT,
  PLINK,
  SECTION_HEAD,
  BTN_SM,
  BTN_GHOST,
  RecentRow,
} from './home-chat-controls';
type HomeChatState = ReturnType<typeof useHomeChatState>;
export function AgentPicker({
  lockedAgent,
  agent,
  list,
  projectId,
  open,
  setOpen,
  chooseAgent,
  strings,
}: Pick<HomeChatState, 'agent' | 'list' | 'projectId' | 'open' | 'setOpen' | 'chooseAgent'> & {
  readonly lockedAgent: HomeChatProps['agent'];
  readonly strings: ComposerStrings;
}) {
  return lockedAgent !== undefined ? null : (
    <Picker
      id="agent"
      testId="composer-agent-picker"
      label={strings.agentPicker(agent === null ? null : agent.name)}
      open={open}
      setOpen={setOpen}
      disabled={agent === null}
    >
      <div className={PHEAD}>{strings.runAs}</div>
      {list.map((option) => {
        const target = runTargetIn(option, projectId);
        return (
          <button
            key={option.id}
            type="button"
            data-testid="composer-agent-option"
            data-agent-id={option.id}
            data-run-target={target.kind}
            className={`${OPT} ${option.id === agent?.id ? 'bg-accent-soft' : ''}`}
            onClick={() => chooseAgent(option.id)}
          >
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{option.name}</span>
              <span className="block text-[12px] text-muted">{option.detail}</span>
              {target.kind === 'unrunnable' ? (
                <span className="block text-[12px] text-warn">
                  {strings.cannotRunYet} · {target.code}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
      <div className={PFOOT}>
        {strings.switchingAgent}{' '}
        <Link className={PLINK} href="/agents">
          {strings.manageAgents}
        </Link>
      </div>
    </Picker>
  );
}

export function ProjectPicker({
  projects,
  projectId,
  setProjectId,
  strings,
}: Pick<HomeChatState, 'projects' | 'projectId' | 'setProjectId'> & {
  readonly strings: ComposerStrings;
}) {
  return projects.length === 0 ? null : (
    <label className="inline-flex items-center gap-1.5 text-[12.5px] text-text-2">
      {strings.project}
      <select
        aria-label={strings.project}
        className="h-[27px] rounded-[999px] border border-border-strong bg-surface px-2.5"
        value={projectId ?? ''}
        onChange={(event) => setProjectId(event.target.value || null)}
      >
        <option value="">{strings.noProject}</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RunTargetNotice({
  agent,
  projectId,
  overrideEntry,
}: Pick<HomeChatState, 'agent' | 'projectId' | 'overrideEntry'>) {
  return agent === null ? null : (
    <p
      id="composer-model-inheritance-line"
      data-testid="composer-run-target"
      data-agent-id={agent.id}
      data-run-target={runTargetIn(agent, projectId).kind}
      className={`text-[12px] ${runTargetWarns(runTargetIn(agent, projectId), overrideEntry !== undefined) ? 'text-warn' : 'text-muted'}`}
    >
      {withSetupWizardLink(
        runTargetLine(
          agent,
          overrideEntry === undefined
            ? null
            : {
                connectionName: overrideEntry.connectionName,
                model: overrideEntry.displayName,
              },
          projectId,
        ),
      )}
    </p>
  );
}

export function RecentSessions({
  recent,
  strings,
}: Pick<HomeChatProps, 'recent'> & { readonly strings: ComposerStrings }) {
  return recent.length === 0 ? null : (
    <>
      <div className={SECTION_HEAD}>
        <h2 className="text-[15px] font-semibold">{strings.recent}</h2>
        <div className="ml-auto flex gap-2">
          <span
            className={`${BTN_SM} ${BTN_GHOST} cursor-not-allowed opacity-[.62]`}
            aria-disabled="true"
          >
            {strings.seeAll}
          </span>
        </div>
      </div>
      <div className="overflow-hidden rounded-(--radius) border border-border bg-surface shadow-(--shadow)">
        {recent.map((run) => (
          <RecentRow key={run.id} run={run} />
        ))}
      </div>
    </>
  );
}
