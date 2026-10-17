import { describe, expect, it } from 'vitest';

import { kebabOf, schemaNameOf, slugOf } from './names.js';

describe('kebabOf', () => {
  it('turns a display name into a portable agent name', () => {
    expect(kebabOf('Support Triage')).toBe('support-triage');
    expect(kebabOf('  --Billing & Refunds (EU)!  ')).toBe('billing-refunds-eu');
  });

  it('is empty when nothing alphanumeric is left, and never ends in a hyphen at 64', () => {
    expect(kebabOf('!!! ???')).toBe('');
    expect(kebabOf(`${'a'.repeat(63)} b`)).toBe('a'.repeat(63));
  });
});

describe('schemaNameOf', () => {
  it('camel-cases the kebab name behind the prefix', () => {
    expect(schemaNameOf('acme', 'support-triage')).toBe('acme_supportTriage');
  });

  it('collapses repeated hyphens and keeps digits', () => {
    expect(schemaNameOf('acme', 'a--b-2c')).toBe('acme_aB2c');
  });

  it('keeps the schema name letter-first and within 64 characters', () => {
    expect(schemaNameOf('acme', '1st-line')).toBe('acme_a1stLine');
    expect(schemaNameOf('acme', 'x'.repeat(64)).split('_')[1]).toHaveLength(64);
    expect(schemaNameOf('acme', `1${'x'.repeat(63)}`).split('_')[1]).toHaveLength(64);
  });
});

describe('slugOf', () => {
  it('is deterministic and file-name safe', () => {
    expect(slugOf('https://help.example.com/a/b')).toBe('help-example-com-a-b');
    expect(slugOf('https://help.example.com/a/b')).toBe(slugOf('https://help.example.com/a/b'));
    expect(slugOf('https://help.example.com')).toBe('help-example-com');
    expect(slugOf('https://help.example.com:8443/Docs/')).toBe('help-example-com-8443-docs');
  });
});
