'use client';
/**
 * shortcut: a fixture-local approval prompt, two buttons and the call, because `ApprovalPrompt`
 * (`@indx-workspace/react`, issue #1490, PR #2058) has not merged; when it has, pass
 * `renderApproval={(props) => <ApprovalPrompt {...props} strings={…} />}` instead and delete this.
 * It is not a part of the app kit and is never published.
 */
import type { AgentPanelApprovalProps } from '@indx-workspace/app/react';
import { useId, type ReactNode } from 'react';

import type { DeskWords } from './words';

export function ApprovalStandIn(
  props: AgentPanelApprovalProps & { readonly words: DeskWords['approval'] },
): ReactNode {
  const { call, pending, problem, onDecide, words } = props;
  const id = useId();
  return (
    <section className="aw-app-panel-note" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>{words.heading}</h3>
      <dl>
        <dt>{words.tool}</dt>
        <dd>
          <code>{call.toolName}</code>
        </dd>
        <dt>{words.call}</dt>
        <dd>
          <code>{call.canonicalCall}</code>
        </dd>
      </dl>
      {problem === null ? null : <p role="alert">{problem}</p>}
      <button
        type="button"
        className="aw-app-button aw-app-primary"
        disabled={pending}
        onClick={() => onDecide('approve', undefined)}
      >
        {words.approve}
      </button>{' '}
      <button
        type="button"
        className="aw-app-button"
        disabled={pending}
        onClick={() => onDecide('reject', undefined)}
      >
        {words.reject}
      </button>
    </section>
  );
}
