import { type ReactNode } from 'react';
import { type AgentEvent } from '@indx-workspace/sdk/events';
import { type Run, type Speaker } from '@indx-workspace/react/run-model';
import { type ComposerPrefill } from '../run/run-view';
import { type ComposerAgent, type ComposerModelConnection, type RecentSession } from './model';
import { type VersionsLocale } from '../agents/versions-messages';

/**
 * The earlier messages of a continued chat, read from the Claude Agent SDK transcript on the server
 * (`server/sessions/history.ts`), with the words said above them in the reader's language.
 */
export interface ResumedHistory {
  readonly heading: string;
  /** Said when older messages were left out; `null` when every message is shown. */
  readonly earlierNote: string | null;
  readonly turns: readonly {
    readonly speaker: 'user' | 'agent';
    readonly paragraphs: readonly string[];
  }[];
}

export type ComposerAgents =
  | {
      readonly kind: 'agents';
      readonly agents: readonly [ComposerAgent, ...ComposerAgent[]];
      /** The agent first-run setup configured, preferred before the user chooses (PR #403). */
      readonly setupAgentId?: string | null;
      /**
       * Whose last-used agent this browser remembers: the workspace and the user id. `null` (or
       * absent) when the signed-in principal could not be resolved; nothing is remembered then.
       */
      readonly viewer?: { readonly workspaceId: string; readonly userId: string } | null;
    }
  | { readonly kind: 'no-agents'; readonly reason: string };

export interface HomeChatProps {
  readonly agents: ComposerAgents;
  readonly modelConnections?: readonly ComposerModelConnection[];
  /** The **Recent** rows, newest first. Empty means the section is not rendered at all. */
  readonly recent: readonly RecentSession[];
  /**
   * The run this screen opens on, or `null` for the composer — §19.5.1 rule 5.
   *
   * `null` is the home page as §45 prints it. A {@link Run} is a conversation that has already
   * started, which is what a resumed session (§20) is, and this screen then *is* the run view
   * from its first paint. The value is passed to {@link screenFor}, which is the one place in
   * this repository that decides between the two screens.
   *
   * The prop is optional and defaults to `null` rather than being required, because a caller
   * that omits it means the home page; `undefined` never reaches {@link screenFor}, which
   * rejects it.
   */
  readonly run?: Run | null;

  /**
   * Who is typing, for the avatar and the name above their own message in the transcript.
   *
   * `null` — the default — means the caller has not resolved the signed-in user, and **Send** is
   * refused for exactly that reason. A message attributed to a person nobody named would be a
   * claim about authorship the screen never checked, and substituting "You" would make that claim
   * silently. In this wave `app/(shell)/page.tsx` passes nothing, because the session cookie
   * carries a workspace slug and no user record has been read; the composer is already inert there
   * for the separate reason that no agent could be offered.
   */
  readonly user?: Speaker | null;

  /**
   * Start every session with this agent and hide the agent picker. An id the list does not hold
   * leaves no session, so **Send** stays off: a locked chat never falls back to another agent.
   */
  readonly agent?: { readonly id: string; readonly locked: true };
  /**
   * The earlier chat this screen continues (UX-05 in #2086): the first message is sent into
   * `sessionId` instead of opening a new session, and `notice` says so above the composer.
   * `refused` is said instead when `/?session=` named a chat this person cannot continue.
   */
  readonly resume?:
    | {
        readonly kind: 'continue';
        readonly sessionId: string;
        readonly notice: string;
        /** Its earlier messages (step 2), shown above the composer; absent when not readable. */
        readonly history?: ResumedHistory;
      }
    | { readonly kind: 'refused'; readonly notice: string };
  /** Starts the first run of a new session on this numbered version of the agent. */
  readonly version?: number;
  /** Sets the composer text, and focuses it, each time `nonce` changes. */
  readonly prefill?: ComposerPrefill;
  /** Receives each agent event of the runs this screen follows, already parsed, with that run's id. */
  readonly onAgentEvent?: (event: AgentEvent, runId?: string) => void;
  /**
   * Follows this run into the transcript each time `nonce` changes after mount: the continuation
   * an approval starts in the session this screen already shows.
   */
  readonly follow?: { readonly runId: string; readonly nonce: number };
  /**
   * A caller's own prompt replaces this screen's Approve / Reject for a paused tool call.
   * Passing null intentionally hides the default prompt.
   */
  readonly approval?: ReactNode;
  /**
   * `false` when the workspace has Files switched off (ADR-0160): **+ Files** and **Attach file**
   * are not shown, since both lead into the switched-off feature (UX-21 in #2086).
   */
  readonly filesEnabled?: boolean;
  /**
   * `false` when another screen's `<main>` holds this chat (the Builder on New Agent): the chat
   * draws a plain `<div>` and an `<h2>`, so the page keeps one landmark and one top heading.
   * Defaults to `true`, the home page.
   */
  readonly landmark?: boolean;
  /**
   * The reader's language for the composer's own words (UX-15 in #2086), negotiated on the server
   * from `Accept-Language` so the first paint is already in it. Defaults to English.
   */
  readonly locale?: VersionsLocale;
}
