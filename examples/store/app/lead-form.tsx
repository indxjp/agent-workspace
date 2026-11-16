'use client';
/**
 * The two forms that leave an address without signing in: the enquiry ("Talk to us") and Notify me
 * on a coming-soon entry. Both are the same form (email, consent that links the privacy notice, the
 * challenge slot) posting to the platform's `POST /api/store/leads` from the visitor's browser. The
 * form refuses to send without consent, and shows the platform's refusal in words (`messages.ts`).
 */
import {
  STORE_ENQUIRY_MAX_LENGTH,
  StoreLeadReceivedResponseSchema,
  type StoreLeadRequest,
} from '@indx-workspace/contracts/email-link';
import { useState, type FormEvent } from 'react';

import { ChallengeSlot, NO_CHALLENGE } from './challenge';
import type { Lang } from './lang';
import { refusalMessage } from './messages';
import { callPlatform } from './platform-api';
import { tr } from './text';

export interface LeadFormProps {
  readonly kind: 'enquiry' | 'launch_notice';
  readonly lang: Lang;
  readonly platformUrl: string;
  /** The entry the form is about: required for a launch notice, optional for an enquiry. */
  readonly entry?: string;
  /** What the enquiry says about the setup chosen on the Customize tab. */
  readonly setup?: Readonly<Record<string, string>>;
  /** The names of the entry and the setup values, to show the visitor what is sent. */
  readonly summary?: readonly string[];
}

export function LeadForm({ kind, lang, platformUrl, entry, setup, summary = [] }: LeadFormProps) {
  const t = tr(lang);
  const [challenge, setChallenge] = useState(NO_CHALLENGE);
  const [problem, setProblem] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const message = String(form.get('message') ?? '').trim();
    setAnswer(null);
    if (form.get('consent') === null) {
      setProblem(t('プライバシー通知に同意してください。', 'Please agree to the privacy notice.'));
      return;
    }
    if (email === '' || (kind === 'enquiry' && message === '')) {
      setProblem(
        kind === 'enquiry'
          ? t(
              'メールアドレスと内容を入力してください。',
              'Please enter your email address and a message.',
            )
          : t('メールアドレスを入力してください。', 'Please enter your email address.'),
      );
      return;
    }
    setProblem(null);
    setSending(true);
    const body: StoreLeadRequest =
      kind === 'enquiry'
        ? {
            kind,
            email,
            consent: true,
            challenge,
            message,
            ...(entry === undefined ? {} : { entry }),
            ...(setup === undefined ? {} : { setup }),
          }
        : { kind, email, consent: true, challenge, entry: entry ?? '' };
    const result = await callPlatform(
      platformUrl,
      '/api/store/leads',
      StoreLeadReceivedResponseSchema,
      {
        method: 'POST',
        body,
      },
    );
    setSending(false);
    setAnswer(
      result.ok
        ? kind === 'enquiry'
          ? t('送信しました。担当者からご連絡します。', 'Sent. We will get back to you.')
          : t(
              '登録しました。公開されたらお知らせします。',
              'Done. We will tell you when it goes live.',
            )
        : refusalMessage(result, lang),
    );
  }

  return (
    <form
      className="aw-app-form"
      data-testid="lead-form"
      onSubmit={(event) => {
        void submit(event);
      }}
      noValidate
    >
      {summary.length > 0 ? (
        <ul aria-label={t('相談の対象', 'What this is about')}>
          {summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <label className="aw-app-field">
        <span className="aw-app-label">{t('メールアドレス', 'Email address')}</span>
        <input type="email" name="email" autoComplete="email" required />
      </label>
      {kind === 'enquiry' ? (
        <label className="aw-app-field">
          <span className="aw-app-label">{t('ご相談の内容', 'Your message')}</span>
          <textarea name="message" rows={5} maxLength={STORE_ENQUIRY_MAX_LENGTH} required />
        </label>
      ) : null}
      <label className="store-consent">
        <input type="checkbox" name="consent" />{' '}
        <span>
          {t('', 'I agree to the ')}
          <a href="/privacy">{t('プライバシー通知', 'privacy notice')}</a>
          {t('に同意します。', '.')}
        </span>
      </label>
      <ChallengeSlot onAnswer={setChallenge} />
      {problem === null ? null : (
        <p className="aw-app-alert" role="alert">
          {problem}
        </p>
      )}
      <button type="submit" className="aw-app-button aw-app-primary" disabled={sending}>
        {kind === 'enquiry' ? t('送信する', 'Send') : t('公開を通知してもらう', 'Notify me')}
      </button>
      <p role="status" data-testid="lead-message">
        {answer}
      </p>
    </form>
  );
}
