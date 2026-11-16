import { expect, it } from 'vitest';

import { type SetupAnswers } from '@indx-workspace/contracts/setup';

import { contentsOf, renderError, rendered } from './render.test-support.js';

const automation = (document: string) =>
  ({
    'setup.theme': 'automation',
    'content.internalTools': ['openapi'],
    'content.openapiDocument': document,
  }) as const satisfies SetupAnswers;

it.each(['https://example.com/orders.json', 'apis/delivery-estimate.openapi.json'])(
  'refuses %s, whose tool would overwrite a starter file, naming the path',
  (document) => {
    const error = renderError(() => rendered(automation(document)));
    expect(error.issues[0]?.path).toBe('content.openapiDocument');
    expect(error.issues[0]?.message).toMatch(
      /would write tools\/[a-z-]+\.ts.*rename the document/u,
    );
  },
);

it('renders a document with another name beside the starter tools, each file once', () => {
  const files = rendered(automation('apis/billing.openapi.json'));
  const paths = files.map((file) => file.path);
  expect(new Set(paths).size).toBe(paths.length);
  const agent = contentsOf(files, 'agents/automation.ts');
  expect(agent).toContain(
    'tools: [\n    billingTool,\n    deliveryEstimateTool,\n    ordersTool,\n  ]',
  );
});
