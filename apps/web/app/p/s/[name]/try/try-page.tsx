/**
 * The try page's markup (ADR-0105 slice 1; S1-18, issue #456): what `GET /p/s/<name>/try` shows.
 * With a model key it is the surface's own full-height chat on the `local` working draft (issue
 * #612), with the one-tag embed snippet collapsed under an Embed disclosure. When a first message
 * would be refused (issue #661) it is one card with the fix for the host OS instead: the page is
 * unauthenticated, so it never accepts a key. Presentational, so it is tested with
 * `renderToStaticMarkup`.
 */
import type { ReactNode } from 'react';

import type { SurfaceDefinition, SurfaceLocale } from '@indx-workspace/contracts/surfaces';
import { Chat } from '@indx-workspace/react';
import { awDevModelFix, surfaceStrings } from '@indx-workspace/react/locale';

import type { SurfaceModelRefusal } from '../../../../../server/surfaces/public/runtime';
import { CopyButton } from './copy-button';

export interface TryPageProps {
  /** The origin the page was asked on, which the printed tag names. */
  readonly origin: string;
  readonly surfaceName: string;
  /** The surface's agent, which the chat talks to. */
  readonly agentName: string;
  /** The surface's definition: its title, greeting, suggested prompts and look. */
  readonly definition: SurfaceDefinition;
  /** The surface's title, or its agent's name when it has none. */
  readonly title: string;
  readonly locale: SurfaceLocale;
  /** Whether the agent has a `production` pointer; without one the page says so. */
  readonly promoted: boolean;
  /** What a first message would be refused with, or `null` (issue #661). */
  readonly modelRefusal: SurfaceModelRefusal | null;
  /** The project's model secret names, for the key fix; `ANTHROPIC_API_KEY` when absent. */
  readonly modelSecrets?: readonly string[] | undefined;
  /** The host's `process.platform`: `aw dev` runs on this machine, so the key command fits it. */
  readonly platform?: string | undefined;
  /** The deployment's runtime banner. */
  readonly banner?: ReactNode;
}

/** Where a model key is made (the provider `aw dev` connects by default). */
const KEY_CONSOLE_URL = 'https://console.anthropic.com/settings/keys';

/** The path of surface `name`'s widget loader. */
function widgetLoaderPath(name: string): string {
  return `/p/s/${name}/widget.js`;
}

/** The one tag a host page adds, as text. */
export function widgetSnippet(origin: string, name: string): string {
  return `<script src="${origin}${widgetLoaderPath(name)}" async></script>`;
}

/** The commands that set `secret` in the shell this machine's `aw dev` was started from. */
export function keyCommands(
  secret: string,
  platform: string | undefined,
): readonly { readonly shell: string; readonly command: string }[] {
  return platform === 'win32'
    ? [
        { shell: 'PowerShell', command: `$env:${secret}="<your-key>"` },
        { shell: 'cmd', command: `set ${secret}=<your-key>` },
      ]
    : [{ shell: 'macOS / Linux', command: `export ${secret}="<your-key>"` }];
}

export function TryPage({
  origin,
  surfaceName,
  agentName,
  definition,
  title,
  locale,
  promoted,
  modelRefusal,
  modelSecrets,
  platform,
  banner,
}: TryPageProps): ReactNode {
  const strings = surfaceStrings(locale);
  if (modelRefusal === null) {
    const snippet = widgetSnippet(origin, surfaceName);
    return (
      <div lang={locale} data-surface-try={surfaceName}>
        <Chat
          environment="local"
          surface={surfaceName}
          agentName={agentName}
          definition={{ ...definition, layout: 'dock' }}
          notice={
            <>
              {banner}
              {promoted ? null : (
                <p
                  role="note"
                  className="px-4 py-2 text-[12px] text-text-2"
                  data-surface-not-promoted=""
                >
                  {strings.tryNotPromoted}
                </p>
              )}
              <details
                className="border-b border-border px-4 py-2 text-[12px]"
                data-surface-embed=""
              >
                <summary className="cursor-pointer font-semibold">{strings.tryEmbed}</summary>
                <figure className="mt-2 flex flex-col gap-2">
                  <figcaption className="text-muted">{strings.trySnippetCaption}</figcaption>
                  <pre className="overflow-x-auto rounded-(--radius) border border-border bg-surface p-3">
                    <code className="font-mono text-[12.5px]">{snippet}</code>
                  </pre>
                  <div>
                    <CopyButton
                      text={snippet}
                      label={strings.tryCopy}
                      copiedLabel={strings.tryCopied}
                    />
                  </div>
                </figure>
              </details>
            </>
          }
        />
      </div>
    );
  }
  const needsKey =
    modelRefusal.code === 'model_connection_unresolved' ||
    modelRefusal.code === 'model_credential_rejected';
  const fix = awDevModelFix(modelRefusal.code, strings, modelSecrets);
  // The console link makes an Anthropic key; a project on other secrets is on another provider.
  const anthropicKey = modelSecrets === undefined || modelSecrets.includes('ANTHROPIC_API_KEY');
  const commands = (modelSecrets ?? ['ANTHROPIC_API_KEY']).flatMap((secret) =>
    keyCommands(secret, platform),
  );
  return (
    <main
      className="mx-auto flex min-h-screen w-full max-w-[640px] flex-col gap-4 p-6"
      lang={locale}
      data-surface-try={surfaceName}
    >
      {banner}
      <h1 className="text-[20px] font-semibold">{strings.tryHeading(title)}</h1>
      <section
        aria-labelledby="try-model-fix"
        className="flex flex-col gap-3 rounded-(--radius) border border-border bg-surface p-4 text-[13px]"
        role="alert"
        data-surface-model-refusal={modelRefusal.code}
      >
        <h2 id="try-model-fix" className="text-[15px] font-semibold">
          {needsKey
            ? strings.tryKeyHeading
            : modelRefusal.code === 'model_connection_failed'
              ? strings.tryModelHeading
              : strings.tryHeading(title)}
        </h2>
        {needsKey ? (
          // The card already says what to do; the server's own sentence is folded away (BH061-052).
          <details className="text-[12px] text-muted">
            <summary className="cursor-pointer font-mono">{modelRefusal.code}</summary>
            {modelRefusal.message}
          </details>
        ) : (
          <p className="text-text-2">
            <span className="font-mono">{modelRefusal.code}: </span>
            {modelRefusal.message}
          </p>
        )}
        {needsKey ? (
          <>
            {anthropicKey ? (
              <p>
                <a
                  className="font-semibold underline"
                  href={KEY_CONSOLE_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {strings.tryGetKey}
                </a>
              </p>
            ) : null}
            <p className="text-text-2">{strings.tryKeyThenRun}</p>
            {commands.map(({ shell, command }) => (
              <div
                key={`${shell} ${command}`}
                className="flex flex-col gap-1"
                data-surface-key-command={shell}
              >
                <span className="text-[12px] font-semibold text-muted">{shell}</span>
                <div className="flex items-center gap-2">
                  <code className="flex-1 overflow-x-auto rounded-(--radius) border border-border px-3 py-2 font-mono text-[12.5px]">
                    {command}
                  </code>
                  <CopyButton
                    text={command}
                    label={strings.tryCopy}
                    copiedLabel={strings.tryCopied}
                  />
                </div>
              </div>
            ))}
            {modelRefusal.code === 'model_connection_unresolved' ? (
              <p className="text-text-2">{strings.tryKeyOrPaste}</p>
            ) : null}
          </>
        ) : fix === null ? null : (
          <p className="font-semibold">{fix}</p>
        )}
      </section>
    </main>
  );
}
