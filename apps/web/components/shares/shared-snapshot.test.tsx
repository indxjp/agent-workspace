import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

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

  it('shows any other snapshot as before, without a session label', () => {
    const html = renderToStaticMarkup(
      createElement(SharedSnapshot, { subjectType: 'agent', snapshot: { name: 'Support' } }),
    );
    expect(html).toContain('Support');
    expect(html).not.toContain('Provided by the person who shared it');
    expect(html).not.toContain('stored record');
  });
});
