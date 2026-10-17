import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { readModelConnections } from './model';
import { ModelsList, ModelsScreen } from './models-screen';

describe('ModelsScreen', () => {
  it('renders the route heading and honest loading state before the request completes', () => {
    const html = renderToStaticMarkup(createElement(ModelsScreen));
    expect(html).toContain('Models');
    expect(html).toContain('+ Add Provider');
    expect(html).toContain('Loading model connections');
  });

  it('never puts a saved API key back in the DOM, including after a second parse (reload)', () => {
    const secret = 'sk-secret-that-must-not-return';
    const response = {
      models: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Azure GPT',
          provider: 'azure-openai',
          config: {
            baseUrl: 'https://company.openai.azure.com',
            deployment: 'gpt-41',
          },
          hasCredential: true,
          apiKey: secret,
        },
      ],
    };
    for (const models of [readModelConnections(response), readModelConnections(response)]) {
      const html = renderToStaticMarkup(createElement(ModelsList, { models, onChange: () => {} }));
      expect(html).toContain('Credential stored securely · write-only');
      expect(html).not.toContain(secret);
      expect(models[0]).not.toHaveProperty('apiKey');
    }
  });
});
