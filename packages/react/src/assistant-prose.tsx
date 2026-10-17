import type { ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * One block of assistant text rendered as Markdown (ADR-0141, issue #1131). The threat model is
 * ADR-0141's: raw HTML is dropped, only the elements below render (no `img`), links pass
 * react-markdown's `defaultUrlTransform` and open outside the chat. Both chats call this once per
 * model text block; user text never comes here.
 */
const ALLOWED_ELEMENTS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr',
  'br',
];

const COMPONENTS: Components = {
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
};

export function AssistantProse({
  text,
  className = 'aw-prose',
}: {
  readonly text: string;
  readonly className?: string;
}): ReactNode {
  return (
    <div className={className}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        components={COMPONENTS}
      >
        {text}
      </Markdown>
    </div>
  );
}
