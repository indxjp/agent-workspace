import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_EMAIL_HINT,
  ADMIN_PASSWORD_HINT,
  AdministratorFields,
  DETECTION_FAILED_MESSAGE,
  ProviderKeyField,
  RuntimeChoices,
} from './setup-wizard';

function administratorStep(): string {
  return renderToStaticMarkup(
    createElement(AdministratorFields, {
      adminEmail: '',
      setAdminEmail: () => undefined,
      adminPassword: '',
      setAdminPassword: () => undefined,
    }),
  );
}

function providerKeyStep(): string {
  return renderToStaticMarkup(
    createElement(ProviderKeyField, { providerApiKey: '', setProviderApiKey: () => undefined }),
  );
}

/** The opening tag of the input named `name`. */
function inputTag(html: string, name: string): string {
  const tag = new RegExp(`<input[^>]*name="${name}"[^>]*>`, 'u').exec(html)?.[0];
  if (tag === undefined) throw new Error(`no input named ${name}`);
  return tag;
}

/** Every `<label>…</label>` in the markup, so a test can say what a label does NOT contain. */
function labels(html: string): string[] {
  return [...html.matchAll(/<label[^>]*>.*?<\/label>/gsu)].map((match) => match[0]);
}

/** A credential field: no browser suggestion, and password managers told to skip it. */
function expectCredentialField(tag: string, autoComplete: 'off' | 'one-time-code'): void {
  expect(tag).toContain('type="password"');
  expect(tag).toContain(`autoComplete="${autoComplete}"`);
  expect(tag).toContain('data-1p-ignore="true"');
  expect(tag).toContain('data-lpignore="true"');
  expect(tag).not.toContain('new-password');
}

// Issue #416: browsers offered a generated or saved password on the "Password" field, so the
// Owner submitted something other than the generator's one-time password.
describe('setup wizard, administrator step', () => {
  it('asks for the one-time setup password and says where it was printed', () => {
    const html = administratorStep();

    expect(html).toContain('One-time setup password');
    expect(html).not.toMatch(/>Password</u);
    expect(ADMIN_PASSWORD_HINT).toContain('.env');
    expect(ADMIN_PASSWORD_HINT).not.toContain('npm create');
    expect(ADMIN_PASSWORD_HINT).toContain('BOOTSTRAP_ADMIN_PASSWORD');
    expect(html).toContain('BOOTSTRAP_ADMIN_PASSWORD');
  });

  it('keeps browsers and password managers from offering generated or saved credentials', () => {
    const html = administratorStep();

    expect(html).not.toContain('new-password');
    // Chrome ignores `off` on a password input and may autofill a saved password; `one-time-code`
    // is not a site password to it (PR #418 review).
    expectCredentialField(inputTag(html, 'adminPassword'), 'one-time-code');
    expect(inputTag(html, 'adminEmail')).toContain('autoComplete="off"');
  });

  it('does not prefill the administrator email, and says where to find it', () => {
    const html = administratorStep();

    expect(inputTag(html, 'adminEmail')).toContain('value=""');
    expect(ADMIN_EMAIL_HINT).toContain('BOOTSTRAP_ADMIN');
    expect(html).toContain('id="setup-adminEmail-hint"');
  });

  // PR #418 review: a hint inside the <label> was read twice — once in the name, once as the
  // description. It sits beside the label and is tied to the input by id.
  it('labels each input by htmlFor and describes it with a hint outside the label', () => {
    const html = administratorStep();

    for (const name of ['adminEmail', 'adminPassword']) {
      const tag = inputTag(html, name);
      expect(tag).toContain(`id="setup-${name}"`);
      expect(tag).toContain(`aria-describedby="setup-${name}-hint"`);
      expect(html).toContain(`for="setup-${name}"`);
      expect(html).toContain(`id="setup-${name}-hint"`);
    }
    for (const label of labels(html)) {
      expect(label).not.toContain('<input');
      expect(label).not.toContain('-hint');
      expect(label).not.toContain('BOOTSTRAP_ADMIN');
    }
  });
});

// PR #418 review: step 2's provider key still said `new-password`, so Chrome offered a generated
// password for an API key — the same class of bug as the administrator step.
describe('setup wizard, provider key step', () => {
  it('treats the provider API key as a stored credential, not a new password', () => {
    const html = providerKeyStep();

    expectCredentialField(inputTag(html, 'providerApiKey'), 'off');
    expect(html).toContain('for="setup-providerApiKey"');
  });
});

describe('setup wizard, runtime step', () => {
  const runtimeStep = (detectionFailed: boolean) =>
    renderToStaticMarkup(
      createElement(RuntimeChoices, {
        detection: null,
        detectionFailed,
        runtime: 'local',
        setRuntime: () => undefined,
      }),
    );

  it('says it is detecting while the host has not answered', () => {
    expect(runtimeStep(false)).toContain('Detecting this host…');
  });

  it('says detection failed instead of detecting forever', () => {
    const html = runtimeStep(true);

    expect(html).toContain(DETECTION_FAILED_MESSAGE);
    expect(html).not.toContain('Detecting this host');
  });
});
