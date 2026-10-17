import process from 'node:process';

// Exercise the same validated login branch as the product adapter. The result file's
// `kind` field, rather than an invalid synthetic login value, identifies this run.
export const loginPath = 'bootstrap-administrator';
export const ready = async () => true;

const pass = () => ({ asserted: true, ok: true, detail: 'harness self-test assertion passed' });
const missingAssertion = () => ({
  asserted: false,
  ok: true,
  detail: 'harness self-test removed the assertion',
});

export const runners = new Proxy(
  {},
  {
    get: (_target, step) => {
      if (process.env.E2E_TEST_FAULT === 'missing-step') {
        return step === 'upload file' ? undefined : pass;
      }
      if (process.env.E2E_TEST_FAULT === 'missing-assertion') {
        return step === 'upload file' ? missingAssertion : pass;
      }
      return pass;
    },
  },
);
