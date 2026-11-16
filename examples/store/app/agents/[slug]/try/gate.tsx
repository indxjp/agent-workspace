'use client';
/**
 * The Try tab's sign-up gate (spec "Email-link sign-in"): an email address, the consent tick that
 * links the privacy notice, the challenge slot and a button. The platform emails a sign-in link;
 * the request is refused on the server without the tick too, so this form's own check is only for
 * the visitor's convenience.
 */
import { useState, type FormEvent } from 'react';

import { EmailLinkIssuedResponseSchema } from '@indx-workspace/contracts/email-link';

import type { LiveEntry } from '../../../../catalog/define';
import { ChallengeSlot } from '../../../challenge';
import { pick, type Lang } from '../../../lang';
import { callPlatform } from '../../../platform-api';
import { consentText, gateRefusalMessage, gateSubmission } from './messages';

const WORDS = {
  heading: { ja: 'このエージェントを試す', en: 'Try this agent' },
  intro: {
    ja: 'メールアドレスにサインイン用のリンクを送ります。あなた専用のデモ環境で、サンプルデータを使って試せます。',
    en: 'We email you a sign-in link. You then try the agent in a demo workspace of your own, on sample data.',
  },
  email: { ja: 'メールアドレス', en: 'Email address' },
  submit: { ja: 'サインインリンクを送る', en: 'Send me the sign-in link' },
  sending: { ja: '送信中…', en: 'Sending…' },
  sent: {
    ja: 'メールを確認してください。サインイン用のリンクをお送りしました。',
    en: 'Check your email. We have sent you the sign-in link.',
  },
};

/** The consent sentence in `lang` (`consentText`), with the privacy notice's link in its place. */
function Consent({ lang }: { readonly lang: Lang }) {
  const text = consentText(lang);
  return (
    <>
      {text.before}
      <a href="/privacy">{text.linkText}</a>
      {text.after}
    </>
  );
}

export function TryGate({
  entry,
  lang,
  platformUrl,
}: {
  readonly entry: LiveEntry;
  readonly lang: Lang;
  readonly platformUrl: string;
}) {
  const [challenge, setChallenge] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const raw = form.get('email');
    const email = typeof raw === 'string' ? raw.trim() : '';
    const consent = form.get('consent') === 'on';
    const decision = gateSubmission({ email, consent, challenge, slug: entry.slug }, lang);
    setError('error' in decision ? decision.error : null);
    setMessage(null);
    if ('error' in decision) return;
    setSending(true);
    const answer = await callPlatform(
      platformUrl,
      '/api/auth/email-link',
      EmailLinkIssuedResponseSchema,
      {
        method: 'POST',
        body: decision.body,
      },
    );
    setSending(false);
    setMessage(answer.ok ? pick(WORDS.sent, lang) : gateRefusalMessage(answer, lang));
  }

  return (
    <form data-testid="try-gate" noValidate onSubmit={(event) => void submit(event)}>
      <h3>{pick(WORDS.heading, lang)}</h3>
      <p>{pick(WORDS.intro, lang)}</p>
      <p>
        <label>
          {pick(WORDS.email, lang)}
          <input type="email" name="email" autoComplete="email" required />
        </label>
      </p>
      <p>
        <label>
          <input type="checkbox" name="consent" />
          <Consent lang={lang} />
        </label>
      </p>
      <ChallengeSlot onAnswer={setChallenge} />
      {error === null ? null : <p role="alert">{error}</p>}
      <button type="submit" disabled={sending}>
        {pick(sending ? WORDS.sending : WORDS.submit, lang)}
      </button>
      <p data-testid="try-gate-message" role="status">
        {message}
      </p>
    </form>
  );
}
