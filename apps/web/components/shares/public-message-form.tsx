'use client';
import { useState } from 'react';
import { CREDENTIAL_INPUT_PROPS } from '../shell/credential-input';

type PublicMessageRequest = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Posts a visitor message to a runnable public share. The passphrase of a protected share travels
 * in the POST body only, never in the URL, so it stays out of history, logs and the Referer header.
 */
export async function sendPublicMessage(
  token: string,
  message: Readonly<{ prompt: string; passphrase?: string }>,
  request: PublicMessageRequest = fetch,
): Promise<string> {
  try {
    const response = await request(`/p/${encodeURIComponent(token)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!response.ok) return `Message refused (${String(response.status)})`;
    return JSON.stringify(await response.json());
  } catch {
    return 'Message could not be sent.';
  }
}

export function PublicMessageForm({
  token,
  passphraseRequired = false,
}: Readonly<{ token: string; passphraseRequired?: boolean }>) {
  const [prompt, setPrompt] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [result, setResult] = useState<string | null>(null);
  async function send() {
    setResult(
      await sendPublicMessage(token, passphraseRequired ? { prompt, passphrase } : { prompt }),
    );
  }
  return (
    <div className="mt-6">
      {passphraseRequired ? (
        <label className="mb-3 block text-[13px] font-semibold">
          Passphrase
          <input
            type="password"
            {...CREDENTIAL_INPUT_PROPS}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="mt-2 w-full rounded border border-border p-3"
          />
        </label>
      ) : null}
      <label className="block text-[13px] font-semibold">
        Send a message
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="mt-2 w-full rounded border border-border p-3"
        />
      </label>
      <button
        type="button"
        onClick={() => void send()}
        className="mt-2 rounded bg-accent px-4 py-2 text-white"
      >
        Send
      </button>
      {result ? (
        <pre className="mt-3 overflow-auto rounded bg-surface-2 p-3 text-[12px]">{result}</pre>
      ) : null}
    </div>
  );
}
