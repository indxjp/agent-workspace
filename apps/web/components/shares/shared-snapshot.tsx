import type { ShareSubjectType } from '@indx-workspace/contracts/shares';
import type { ReactNode } from 'react';
import { z } from 'zod';

/** The transcript a session share stores (ADR-0158); read back, so parsed rather than trusted. */
const SessionTranscriptSchema = z.object({
  kind: z.literal('session-transcript'),
  version: z.literal(1),
  turns: z.array(z.object({ prompt: z.string().nullable(), answer: z.string().nullable() })),
});

/**
 * An agent definition a share published (`exportAgentDefinition`), secrets already masked. The
 * definition is still caller-authored until RF-103 builds it from the stored agent, so a
 * `description` of any other type is dropped rather than turning the whole panel into JSON.
 */
const AgentDefinitionSchema = z.object({
  definition: z.object({
    instructions: z.string(),
    description: z.string().optional().catch(undefined),
  }),
  requirements: z.array(z.string()),
});

const PUBLISHER_PROVIDED = (record: string) =>
  `Provided by the person who shared it; not checked against the ${record}'s record.`;

/** The box every snapshot is shown in. */
function Panel({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="mt-5 rounded-(--radius) border border-border bg-surface p-5">{children}</div>
  );
}

function AgentDefinition({ value }: Readonly<{ value: z.infer<typeof AgentDefinitionSchema> }>) {
  const { description, instructions } = value.definition;
  return (
    <Panel>
      <p className="mb-3 text-[12px] text-muted">{PUBLISHER_PROVIDED('agent')}</p>
      {description === undefined ? null : (
        <p className="text-[14px] [overflow-wrap:anywhere]">{description}</p>
      )}
      <h2 className="mt-3 text-[12px] font-semibold text-muted first:mt-0">Instructions</h2>
      <p className="mt-1 whitespace-pre-wrap text-[14px] [overflow-wrap:anywhere]">
        {instructions}
      </p>
      {value.requirements.length === 0 ? null : (
        <>
          <h2 className="mt-3 text-[12px] font-semibold text-muted">To use it you need</h2>
          <ul className="mt-1 list-disc pl-5 text-[14px]">
            {value.requirements.map((requirement, index) => (
              // Two requirements may read the same; the position keeps their keys apart.
              <li key={`${String(index)}:${requirement}`}>{requirement}</li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function Json({ value }: Readonly<{ value: unknown }>) {
  return (
    <pre className="overflow-auto whitespace-pre-wrap text-[13px]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/**
 * What a share's visitor is shown. A transcript the server copied from the session's runs is the
 * conversation, and an agent's published definition is its instructions and what it needs; any
 * other session snapshot predates ADR-0158 and is client-supplied text, so it is labelled as the
 * publisher's, and any other unreadable snapshot is described in words. A share with no snapshot (an agent shared from the console stores none until RF-103
 * builds the definition from the stored agent) says so in words, never as `null` (#2087).
 */
export function SharedSnapshot({
  subjectType,
  snapshot,
}: Readonly<{ subjectType: ShareSubjectType; snapshot: unknown }>) {
  if (snapshot === null || snapshot === undefined) {
    return (
      <Panel>
        <p className="text-[14px] text-muted">Only the name was shared with this link.</p>
      </Panel>
    );
  }
  const definition = AgentDefinitionSchema.safeParse(snapshot);
  if (subjectType === 'agent' && definition.success) {
    return <AgentDefinition value={definition.data} />;
  }
  const transcript = SessionTranscriptSchema.safeParse(snapshot);
  if (subjectType === 'session' && transcript.success) {
    return (
      <Panel>
        <p className="text-[12px] text-muted">
          Copied from the session&apos;s stored record when it was shared. Secret values are masked.
        </p>
        {transcript.data.turns.map((turn, index) => (
          <section key={index} className="mt-4 text-[14px]">
            <h2 className="text-[12px] font-semibold text-muted">Prompt</h2>
            <p className="mt-1 whitespace-pre-wrap">{turn.prompt ?? 'Not recorded.'}</p>
            <h2 className="mt-3 text-[12px] font-semibold text-muted">Answer</h2>
            <p className="mt-1 whitespace-pre-wrap">
              {turn.answer ?? 'The run did not finish with an answer.'}
            </p>
          </section>
        ))}
      </Panel>
    );
  }
  // Anything else is a snapshot stored before raw snapshots were refused. An older session
  // snapshot is still shown, labelled as the publisher's; any other share never shows raw JSON
  // to a visitor (#2087), so it says in words that its content cannot be shown.
  if (subjectType !== 'session') {
    return (
      <Panel>
        <p className="text-[14px] text-muted">
          This link was shared in an older format, so only the name can be shown.
        </p>
      </Panel>
    );
  }
  return (
    <Panel>
      <p className="mb-3 text-[12px] text-muted">{PUBLISHER_PROVIDED('session')}</p>
      <Json value={snapshot} />
    </Panel>
  );
}
