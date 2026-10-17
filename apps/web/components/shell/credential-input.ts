/**
 * Issue #416 / PR #418: the props every field that takes a stored credential — a provider API key,
 * a connector credential, a one-time setup password — carries, so neither the browser nor a
 * password manager offers a generated or saved password for it. Marking a field a new password is
 * exactly what invites Chrome's "suggest strong password", which the Owner then submitted in
 * place of the real key. 1Password reads `data-1p-ignore`; LastPass reads `data-lpignore`.
 */
export const CREDENTIAL_INPUT_PROPS = {
  autoComplete: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
} as const;

/**
 * PR #418 review: Chrome ignores `autocomplete="off"` on a `type="password"` input and may still
 * autofill a saved password into it. The setup wizard's one-time setup password therefore says
 * `one-time-code` — a value Chromium does not treat as a site password — with the same
 * password-manager opt-outs. The API-key fields keep {@link CREDENTIAL_INPUT_PROPS}.
 */
export const ONE_TIME_CODE_INPUT_PROPS = {
  autoComplete: 'one-time-code',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
} as const;
