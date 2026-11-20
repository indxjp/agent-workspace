/** The development issuer's sign-in form, `form_post` page and their locale and security policy. */
import { createHash } from 'node:crypto';

/** The two languages the sign-in form speaks (DI6). */
export type DevIssuerLocale = 'en' | 'ja';

/** `ja` when the first language `Accept-Language` names that the form speaks is Japanese. */
export function formLocale(acceptLanguage: string | undefined): DevIssuerLocale {
  for (const part of (acceptLanguage ?? '').split(',')) {
    const [tag = '', ...parameters] = part.trim().toLowerCase().split(';');
    if (parameters.some((parameter) => /^q=0(?:\.0*)?$/u.test(parameter.trim()))) continue;
    if (tag === 'ja' || tag.startsWith('ja-')) return 'ja';
    if (tag === 'en' || tag.startsWith('en-') || tag === '*') return 'en';
  }
  return 'en';
}

export const TEXT: Readonly<
  Record<
    DevIssuerLocale,
    {
      readonly title: string;
      readonly intro: string;
      readonly email: string;
      readonly password: string;
      readonly passwordHint: string;
      readonly submit: string;
      readonly refused: string;
      readonly limited: string;
      readonly continue: string;
      readonly invalidClient: string;
      readonly invalidRedirect: string;
    }
  >
> = {
  en: {
    title: 'Sign in to the local workspace',
    intro: 'aw dev’s development sign-in. Use a member’s email and the local console password.',
    email: 'Email',
    password: 'Local console password',
    passwordHint: 'aw dev prints where it is: your environment, .env or .agent-workspace/secrets.',
    submit: 'Sign in',
    refused: 'That email or password was not accepted.',
    limited: 'Too many attempts. Wait a minute and try again.',
    continue: 'Continue',
    invalidClient: 'This sign-in request names an application aw dev does not know.',
    invalidRedirect:
      'This sign-in request names a return address the application did not register.',
  },
  ja: {
    title: 'ローカルワークスペースにサインイン',
    intro:
      'aw dev の開発用サインインです。メンバーのメールアドレスとローカルコンソールのパスワードを入力してください。',
    email: 'メールアドレス',
    password: 'ローカルコンソールのパスワード',
    passwordHint: '保存場所は aw dev が表示します（環境変数、.env、.agent-workspace/secrets）。',
    submit: 'サインイン',
    refused: 'メールアドレスまたはパスワードが受け付けられませんでした。',
    limited: '試行回数が多すぎます。1 分ほど待ってからもう一度お試しください。',
    continue: '続ける',
    invalidClient: 'このサインイン要求は aw dev が知らないアプリケーションを指しています。',
    invalidRedirect: 'このサインイン要求の戻り先は、アプリケーションが登録したものではありません。',
  },
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => `&#${String(character.charCodeAt(0))};`);
}

const STYLE =
  'body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}' +
  'label{display:block;margin-top:1rem;font-weight:600}' +
  'input{display:block;width:100%;box-sizing:border-box;padding:.5rem;font:inherit}' +
  'button{margin-top:1.5rem;padding:.5rem 1rem;font:inherit}' +
  '[role=alert]{color:#a00;font-weight:600}' +
  ':focus-visible{outline:3px solid #1a5fb4;outline-offset:2px}';

export function page(locale: DevIssuerLocale, title: string, body: string): string {
  return (
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
    `<body><main>${body}</main></body></html>`
  );
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

/** The sign-in form (DI6): labelled fields, keyboard-operable, errors in an `aria-live` region. */
export function signInForm(
  locale: DevIssuerLocale,
  request: Readonly<Record<string, string | undefined>>,
  email: string,
  error: 'refused' | 'limited' | undefined,
): string {
  const text = TEXT[locale];
  const carried = Object.entries(request)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, value]) => hidden(name, value))
    .join('');
  const message = error === undefined ? '' : escapeHtml(text[error]);
  return page(
    locale,
    text.title,
    `<h1>${escapeHtml(text.title)}</h1><p>${escapeHtml(text.intro)}</p>` +
      `<div aria-live="assertive" role="alert" id="error">${message}</div>` +
      `<form method="post" action="/authorize">${carried}` +
      `<label for="email">${escapeHtml(text.email)}</label>` +
      `<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}"` +
      `${error === undefined ? '' : ' aria-invalid="true" aria-describedby="error"'}>` +
      `<label for="password">${escapeHtml(text.password)}</label>` +
      `<input id="password" name="password" type="password" autocomplete="current-password" required aria-describedby="password-hint"${error === undefined ? ' autofocus' : ''}>` +
      `<p id="password-hint">${escapeHtml(text.passwordHint)}</p>` +
      `<button type="submit">${escapeHtml(text.submit)}</button></form>`,
  );
}

/** The script that submits a `form_post` answer; its hash is the page's only `script-src`. */
const FORM_POST_SCRIPT = 'document.forms[0].submit();';
const FORM_POST_SCRIPT_HASH = `'sha256-${createHash('sha256').update(FORM_POST_SCRIPT).digest('base64')}'`;

/** The `form_post` answer: the parameters as a form the browser posts to the client. */
export function formPostPage(
  locale: DevIssuerLocale,
  redirectUri: string,
  parameters: Readonly<Record<string, string>>,
): string {
  const text = TEXT[locale];
  const fields = Object.entries(parameters)
    .map(([name, value]) => hidden(name, value))
    .join('');
  return page(
    locale,
    text.title,
    `<form method="post" action="${escapeHtml(redirectUri)}">${fields}` +
      `<button type="submit">${escapeHtml(text.continue)}</button></form>` +
      `<script>${FORM_POST_SCRIPT}</script>`,
  );
}

/**
 * DI6's policy. `form-action` also names the client's origin, because browsers apply it to the
 * redirect that follows the form and to the `form_post` answer's form; a `form_post` page allows
 * its one script by hash. The smallest change that lets the ADR's flow complete in a browser.
 */
export function contentSecurityPolicy(clientOrigin: string | undefined, script: boolean): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    ...(script ? [`script-src ${FORM_POST_SCRIPT_HASH}`] : []),
    `form-action 'self'${clientOrigin === undefined ? '' : ` ${clientOrigin}`}`,
    "frame-ancestors 'none'",
  ].join('; ');
}
