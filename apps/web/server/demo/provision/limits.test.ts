import { describe, expect, it } from 'vitest';

import {
  ARGUMENT_PIECE_CHARACTERS,
  DEMO_SAMPLE_FILE_MAX_BYTES,
  DEMO_SEED_BODY_MAX_BYTES,
  OWNER_BINDING_SECONDS,
  RECORDS_JSON_MAX_BYTES,
  RECORDS_PER_ANSWER,
} from './limits';
import { DEMO_TEMPLATE_OWNER_DOMAIN, isTemplateOwnerEmail } from './template-owner';

describe('the demo provisioner limits', () => {
  it('pins the largest sample file to 1 MiB, the size the catalog test holds seed files to', () => {
    expect(DEMO_SAMPLE_FILE_MAX_BYTES).toBe(1_048_576);
  });

  it('pins the records stand-in and seed route limits', () => {
    expect(RECORDS_PER_ANSWER).toBe(100);
    expect(ARGUMENT_PIECE_CHARACTERS).toBe(30_000);
    expect(RECORDS_JSON_MAX_BYTES).toBe(600_000);
    expect(DEMO_SEED_BODY_MAX_BYTES).toBe(33_554_432);
    expect(OWNER_BINDING_SECONDS).toBe(3_600);
  });

  it('knows a template-owner account only by the reserved domain', () => {
    expect(DEMO_TEMPLATE_OWNER_DOMAIN).toBe('demo-templates.invalid');
    expect(isTemplateOwnerEmail('seed@demo-templates.invalid')).toBe(true);
    expect(isTemplateOwnerEmail(' Seed@Demo-Templates.INVALID ')).toBe(true);
    expect(isTemplateOwnerEmail('seed@example.com')).toBe(false);
    expect(isTemplateOwnerEmail('seed@demo-templates.invalid.example.com')).toBe(false);
    expect(isTemplateOwnerEmail('seed@evil-demo-templates.invalid')).toBe(false);
  });
});
