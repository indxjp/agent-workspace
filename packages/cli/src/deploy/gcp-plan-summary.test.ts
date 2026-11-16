import { expect, it } from 'vitest';
import { fixture } from './gcp-fixtures.test-support.ts';
import { summarisePlan } from './gcp-lifecycle.js';
import { createRedactor } from './redact.js';

const redact = createRedactor({ BOOTSTRAP_ADMIN_PASSWORD: 'plan-time-secret-value' });

it('prints counts by action and kind, protection and the idle cost (golden)', async () => {
  const summary = summarisePlan(await fixture('plan.json'));

  expect(redact(summary)).toBe(await fixture('plan-summary.txt'));
});

it('prints the standard idle cost when the plan sets size standard', async () => {
  const plan: unknown = JSON.parse(await fixture('plan.json'));
  const standard = JSON.stringify({
    ...(plan as object),
    variables: { size: { value: 'standard' } },
  });

  const summary = summarisePlan(standard);

  expect(summary).toContain('Idle cost: standard: regional high-availability Cloud SQL');
  expect(summary).not.toContain('Idle cost: small');
});

it('names the egress proxy VM and Cloud NAT, with no figure, when the plan sets sandbox_internet', async () => {
  const plan: unknown = JSON.parse(await fixture('plan.json'));
  const withInternet = (value: boolean) =>
    summarisePlan(
      JSON.stringify({ ...(plan as object), variables: { sandbox_internet: { value } } }),
    );

  expect(withInternet(true)).toContain(
    'are the idle costs plus one small Compute Engine VM (the sandbox egress proxy) and one Cloud NAT gateway at list price (https://cloud.google.com/products/compute/pricing, https://cloud.google.com/nat/pricing)\n',
  );
  expect(withInternet(true)).not.toMatch(/\$\d/u);
  expect(withInternet(false)).toBe(await fixture('plan-summary.txt'));
});

it('flags a Cloud SQL replacement and a bucket deletion as protected', async () => {
  const summary = summarisePlan(await fixture('plan-protected.json'));

  expect(summary).toContain('0 to create, 1 to update, 1 to delete, 1 to replace');
  expect(summary).toContain(
    'PROTECTED: google_sql_database_instance.main (Cloud SQL instance) would be replaced; its data is lost',
  );
  expect(summary).toContain(
    'PROTECTED: google_storage_bucket.objects (storage bucket) would be deleted; its data is lost',
  );
});

it('refuses text that is not a plan', () => {
  expect(() => summarisePlan('not json')).toThrow('did not print a plan');
});
