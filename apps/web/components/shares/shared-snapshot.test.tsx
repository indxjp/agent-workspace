import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { exportAgentDefinition } from '../../server/shares/agent-definition/definition';
import { sessionTranscriptSnapshot } from '../../server/shares/session-snapshot/snapshot';
import { SharedSnapshot } from './shared-snapshot';

const SESSION = '55555555-5555-4555-8555-555555555555';

describe('SharedSnapshot', () => {
  it('renders a transcript the server copied as the conversation, labelled as the record', () => {
    const snapshot = sessionTranscriptSnapshot(
      SESSION,
      [
        {
          id: '11111111-1111-4111-8111-111111111111',
          sessionId: SESSION,
          createdAt: new Date('2026-10-19T10:00:00Z'),
          prompt: 'What changed <today>?',
          answer: 'The gateway restarted.',
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          sessionId: SESSION,
          createdAt: new Date('2026-10-19T10:01:00Z'),
          prompt: 'And then?',
          answer: null,
        },
      ],
      [],
    );
    const html = renderToStaticMarkup(
      createElement(SharedSnapshot, { subjectType: 'session', snapshot }),
    );
    expect(html).toContain('Copied from the session&#x27;s stored record when it was shared.');
    expect(html).toContain('What changed &lt;today&gt;?');
    expect(html).toContain('The gateway restarted.');
    expect(html).toContain('The run did not finish with an answer.');
    expect(html).not.toContain('<pre');
  });

  it('marks an older client-supplied session snapshot as provided by the publisher', () => {
    const html = renderToStaticMarkup(
      createElement(SharedSnapshot, {
        subjectType: 'session',
        snapshot: [{ kind: 'agent', blocks: [] }],
      }),
    );
    expect(html).toContain('Provided by the person who shared it');
    expect(html).toContain('<pre');
  });

  it.each(['agent', 'project', 'skill'] as const)(
    'never shows an unreadable %s snapshot as JSON, and says so in words (#2087)',
    (subjectType) => {
      const html = renderToStaticMarkup(
        createElement(SharedSnapshot, { subjectType, snapshot: { name: 'Support' } }),
      );
      expect(html).toContain(
        'This link was shared in an older format, so only the name can be shown.',
      );
      expect(html).not.toContain('Support');
      expect(html).not.toContain('<pre');
    },
  );

  it('keeps two identical requirements apart', () => {
    const html = renderToStaticMarkup(
      createElement(SharedSnapshot, {
        subjectType: 'agent',
        snapshot: {
          definition: { instructions: 'Help.' },
          requirements: ['Connector: crm', 'Connector: crm'],
        },
      }),
    );
    expect(html.match(/<li>Connector: crm<\/li>/gu)).toHaveLength(2);
  });
  // #2087: an agent shared from the console stores no snapshot, and the page showed `null`.
  it.each([
    ['agent', null],
    ['agent', undefined],
    ['session', null],
    ['project', null],
    ['skill', undefined],
  ] as const)(
    'says in words that a %s share with a %s snapshot has nothing more',
    (subjectType, snapshot) => {
      const html = renderToStaticMarkup(createElement(SharedSnapshot, { subjectType, snapshot }));
      expect(html).toContain('Only the name was shared with this link.');
      expect(html).not.toContain('null');
      expect(html).not.toContain('<pre');
      expect(html).not.toContain('Provided by the person who shared it');
    },
  );

  it('shows a published agent definition as its instructions and what it needs, not JSON', () => {
    const snapshot = exportAgentDefinition(
      {
        name: 'Support',
        description: 'Answers <billing> questions.',
        instructions: 'Use the key sk-live-123 to look up invoices.',
        modelConnectionName: 'anthropic default',
        connectorNames: ['zendesk'],
        fileCount: 2,
      },
      ['sk-live-123'],
      [],
    );
    const html = renderToStaticMarkup(
      createElement(SharedSnapshot, { subjectType: 'agent', snapshot }),
    );
    expect(html).toContain('Answers &lt;billing&gt; questions.');
    expect(html).toContain('Use the key {{REQUIRED_SECRET}} to look up invoices.');
    expect(html).not.toContain('sk-live-123');
    expect(html).toContain('To use it you need');
    expect(html).toContain(
      'connector &quot;zendesk&quot; (you will be asked for your own credentials)',
    );
    expect(html).toContain('2 files (not included in this share)');
    expect(html).not.toContain('<pre');
    expect(html).not.toContain('{&quot;');
  });

  it("labels a published agent definition as the publisher's, like an older session snapshot", () => {
    const snapshot = exportAgentDefinition({ name: 'X', instructions: 'Be brief.' }, [], []);
    const html = renderToStaticMarkup(
      createElement(SharedSnapshot, { subjectType: 'agent', snapshot }),
    );
    expect(html).toContain(
      'Provided by the person who shared it; not checked against the agent&#x27;s record.',
    );
  });

  it('drops a description that is not text instead of falling back to JSON', () => {
    const snapshot = exportAgentDefinition(
      { name: 'X', instructions: 'Be brief.', description: null },
      [],
      [],
    );
    const html = renderToStaticMarkup(
      createElement(SharedSnapshot, { subjectType: 'agent', snapshot }),
    );
    expect(html).toContain('Be brief.');
    expect(html).not.toContain('<pre');
  });

  it('leaves out the empty parts of an agent definition', () => {
    const snapshot = exportAgentDefinition({ name: 'Bare', instructions: 'Be brief.' }, [], []);
    const html = renderToStaticMarkup(
      createElement(SharedSnapshot, { subjectType: 'agent', snapshot }),
    );
    expect(html).toContain('Be brief.');
    expect(html).not.toContain('To use it you need');
    expect(html).not.toContain('<ul');
  });

  it('does not read a session snapshot shaped like a definition as an agent', () => {
    const snapshot = exportAgentDefinition({ name: 'X', instructions: 'Hidden?' }, [], []);
    const html = renderToStaticMarkup(
      createElement(SharedSnapshot, { subjectType: 'session', snapshot }),
    );
    expect(html).toContain('Provided by the person who shared it');
    expect(html).not.toContain('To use it you need');
  });
});
