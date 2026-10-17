'use client';

/**
 * The agent screen's Platforms tab (issue #973): which platforms can run a saved version, what an
 * export would drop, the bundle to download and the command that publishes it. It is a view over
 * the platform routes of #968; every call goes through the SDK client, never `fetch`, and the
 * server decides who may export.
 */
import { createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import type { AgentVersionListResponse } from '@indx-workspace/contracts/agent-versions';
import type {
  FieldVerdict,
  HostedPlatformId,
  PlatformDescriptor,
  PlatformId,
} from '@indx-workspace/contracts/platforms';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import {
  agentCardUrl,
  checkFailure,
  defaultExportVersion,
  capabilityFields,
  isHostedPlatform,
  publishCommand,
  verdictCounts,
  type AgentTab,
  type PlatformCheck,
} from './platforms-model';
import { platformRefusalText, platformsStrings, type PlatformsStrings } from './platforms-messages';
import { BUTTON, SECONDARY_BUTTON, TD, TH } from './table-styles';
import { badgesFor } from './versions-model';
import { versionsStrings, type VersionsLocale } from './versions-messages';

const BADGE = 'rounded-full px-2 py-px text-[11.5px] whitespace-nowrap';
const SUPPORT_TONE = {
  native: 'bg-ok-soft text-ok',
  mapped: 'bg-info-soft text-text',
  unsupported: 'bg-warn-soft text-warn',
  dropped: 'bg-warn-soft text-warn',
} as const;

const sessionClient = (): AgentWorkspaceClient =>
  createClient({ baseUrl: window.location.origin, auth: { kind: 'session' } });

/** The agent page's tab bar; `aria-current` and the weight mark the tab being shown. */
export function AgentTabs({
  agentId,
  current,
  locale,
}: Readonly<{ agentId: string; current: AgentTab; locale: VersionsLocale }>) {
  const strings = versionsStrings(locale);
  const base = `/agents/${encodeURIComponent(agentId)}`;
  const tabs: readonly { tab: AgentTab; href: string; label: string }[] = [
    { tab: 'configuration', href: base, label: strings.tabConfiguration },
    { tab: 'versions', href: `${base}?tab=versions`, label: strings.tabVersions },
    { tab: 'platforms', href: `${base}?tab=platforms`, label: strings.tabPlatforms },
  ];
  return (
    <nav
      aria-label={strings.tabsLabel}
      lang={locale}
      className="flex gap-4 px-8 pt-[26px] text-[13px]"
    >
      {tabs.map(({ tab, href, label }) => (
        <Link
          key={tab}
          href={href}
          className={tab === current ? 'font-semibold' : 'text-accent'}
          aria-current={tab === current ? 'page' : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

function Badge({
  tone,
  children,
}: Readonly<{ tone: keyof typeof SUPPORT_TONE; children: string }>) {
  return <span className={`${BADGE} ${SUPPORT_TONE[tone]}`}>{children}</span>;
}

export function PlatformMatrix({
  platforms,
  checking,
  onCheck,
  strings,
}: Readonly<{
  platforms: readonly PlatformDescriptor[];
  checking: PlatformCheck;
  onCheck: (platform: PlatformId) => void;
  strings: PlatformsStrings;
}>) {
  const fields = capabilityFields(platforms);
  return (
    <div className="overflow-x-auto rounded-(--radius) border border-border bg-surface">
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">{strings.matrixCaption}</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>
              {strings.columnPlatform}
            </th>
            {fields.map((field) => (
              <th key={field} scope="col" className={TH}>
                {field}
              </th>
            ))}
            <th scope="col" className={TH}>
              {strings.columnCheck}
            </th>
          </tr>
        </thead>
        <tbody>
          {platforms.map((platform) => {
            const supports = new Map(Object.entries(platform.capabilities));
            return (
              <tr key={platform.id} data-platform={platform.id}>
                <th scope="row" className={`${TD} text-left font-normal whitespace-nowrap`}>
                  <a
                    href={platform.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                  >
                    {platform.displayName}
                    <span className="sr-only"> {strings.newTab}</span>
                  </a>
                </th>
                {fields.map((field) => {
                  const support = supports.get(field);
                  return (
                    <td key={field} className={TD}>
                      {support === undefined ? null : (
                        <Badge tone={support}>{strings.capabilities[support]}</Badge>
                      )}
                    </td>
                  );
                })}
                <td className={`${TD} whitespace-nowrap`}>
                  {isHostedPlatform(platform.id) ? (
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      disabled={checking.kind === 'checking'}
                      aria-label={strings.check(platform.displayName)}
                      onClick={() => {
                        onCheck(platform.id);
                      }}
                    >
                      {strings.columnCheck}
                    </button>
                  ) : (
                    <span className="text-muted">{strings.noCheck}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function VerdictTable({
  report,
  strings,
}: Readonly<{ report: readonly FieldVerdict[]; strings: PlatformsStrings }>) {
  return (
    <div className="overflow-x-auto rounded-(--radius) border border-border bg-surface">
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">{strings.verdictCaption}</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>
              {strings.columnField}
            </th>
            <th scope="col" className={TH}>
              {strings.columnVerdict}
            </th>
            <th scope="col" className={TH}>
              {strings.columnWhy}
            </th>
          </tr>
        </thead>
        <tbody>
          {report.map((field) => (
            <tr key={field.path}>
              <td className={`${TD} font-mono`}>{field.path}</td>
              <td className={TD}>
                <Badge tone={field.verdict}>{strings.verdicts[field.verdict]}</Badge>
              </td>
              <td className={TD}>
                {field.note}
                {field.code === undefined ? null : (
                  <code className="ml-2 font-mono text-[12px] text-muted">{field.code}</code>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Text to take to a terminal or a browser, read-only and selectable, with a Copy button that says when it fails. */
function CopyableText({
  label,
  text,
  hint,
  strings,
}: Readonly<{ label: string; text: string; hint?: string; strings: PlatformsStrings }>) {
  const [outcome, setOutcome] = useState<'copied' | 'failed' | null>(null);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setOutcome('copied');
    } catch {
      setOutcome('failed');
    }
  }
  return (
    <div className="space-y-1.5">
      <p className="text-[13px] font-semibold">{label}</p>
      {hint === undefined ? null : <p className="text-[13px] text-muted">{hint}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded border border-border bg-surface-2 px-2 py-1 font-mono text-[12.5px] break-all select-all">
          {text}
        </code>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          aria-label={`${strings.copy} ${label}`}
          onClick={() => {
            void copy();
          }}
        >
          {strings.copy}
        </button>
      </div>
      <p role={outcome === 'failed' ? 'alert' : 'status'} className="text-[13px] text-muted">
        {outcome === 'copied' ? strings.copied : null}
        {outcome === 'failed' ? <span className="text-danger">{strings.copyFailed}</span> : null}
      </p>
    </div>
  );
}

/** The outcome of the last Check; always rendered, so a screen reader hears the result arrive. */
export function PlatformResult({
  check,
  displayName,
  agentName,
  origin,
  downloading,
  onDownload,
  strings,
}: Readonly<{
  check: PlatformCheck;
  displayName: string;
  agentName: string;
  origin: string;
  downloading: boolean;
  onDownload: () => void;
  strings: PlatformsStrings;
}>) {
  return (
    <section
      role="region"
      aria-live="polite"
      aria-label={strings.resultRegion}
      className="space-y-3"
    >
      {check.kind === 'checking' ? <p className="text-muted">{strings.checking}</p> : null}
      {check.kind === 'failed' ? (
        <p className="rounded bg-danger-soft px-3 py-2 text-danger">{strings.unavailable}</p>
      ) : null}
      {check.kind === 'refused' ? (
        <div className="space-y-1 rounded bg-danger-soft px-3 py-2 text-danger">
          <p>{platformRefusalText(check.code, strings)}</p>
          {check.details.length === 0 ? null : (
            <>
              <p className="font-semibold">{strings.refusalDetails}</p>
              <ul className="list-disc pl-5">
                {check.details.map((detail, index) => (
                  <li key={`${String(index)}-${detail}`}>{detail}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
      {check.kind === 'exported' ? (
        <>
          <h2 className="text-[15px]">
            {strings.resultHeading(displayName, check.response.version)}
          </h2>
          <p>{strings.summary(verdictCounts(check.response.report))}</p>
          <VerdictTable report={check.response.report} strings={strings} />
          <div>
            <button type="button" className={BUTTON} disabled={downloading} onClick={onDownload}>
              {downloading ? strings.downloading : strings.download}
            </button>
          </div>
          <CopyableText
            label={strings.publishLabel}
            text={publishCommand(check.platform, agentName)}
            hint={strings.publishHint}
            strings={strings}
          />
          {check.platform === 'gemini-enterprise' ? (
            <CopyableText
              label={strings.cardUrlLabel}
              text={agentCardUrl(origin, agentName)}
              strings={strings}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

type Loaded = {
  readonly platforms: readonly PlatformDescriptor[];
  readonly listing: AgentVersionListResponse;
};

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | ({ readonly kind: 'ready' } & Loaded);

async function saveArchive(
  client: AgentWorkspaceClient,
  agentId: string,
  version: number,
  platform: HostedPlatformId,
): Promise<void> {
  const archive = await client.platforms.exportArchive(agentId, version, { platform });
  const url = URL.createObjectURL(new Blob([archive.bytes.slice()], { type: 'application/x-tar' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = archive.filename;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AgentPlatformsScreen({
  agentId,
  locale,
}: Readonly<{ agentId: string; locale: VersionsLocale }>) {
  const strings = platformsStrings(locale);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [version, setVersion] = useState<number | null>(null);
  const [check, setCheck] = useState<PlatformCheck>({ kind: 'idle' });
  const [downloading, setDownloading] = useState(false);
  const [downloadFailure, setDownloadFailure] = useState<string | null>(null);
  // A result that arrives after the version changed, or after a newer check began, is dropped.
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const client = sessionClient();
    Promise.all([
      client.platforms.list({ signal: controller.signal }),
      client.agents.versions.list(agentId, { signal: controller.signal }),
    ]).then(
      ([platforms, listing]) => {
        if (controller.signal.aborted) return;
        setVersion(defaultExportVersion(listing));
        setState({ kind: 'ready', platforms, listing });
      },
      () => {
        if (!controller.signal.aborted) setState({ kind: 'failed' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [agentId]);

  function chooseVersion(next: number): void {
    generation.current += 1;
    setVersion(next);
    setCheck({ kind: 'idle' });
    setDownloading(false);
    setDownloadFailure(null);
  }

  async function runCheck(platform: PlatformId): Promise<void> {
    if (version === null || !isHostedPlatform(platform)) return;
    generation.current += 1;
    const mine = generation.current;
    setCheck({ kind: 'checking', platform });
    setDownloading(false);
    setDownloadFailure(null);
    try {
      const response = await sessionClient().platforms.export(agentId, version, { platform });
      if (generation.current === mine) setCheck({ kind: 'exported', platform, response });
    } catch (error) {
      if (generation.current === mine) setCheck(checkFailure(platform, error));
    }
  }

  async function download(platform: PlatformId): Promise<void> {
    if (version === null || !isHostedPlatform(platform)) return;
    // A download that settles after the version changed or a newer check began leaves no trace.
    const mine = generation.current;
    setDownloading(true);
    setDownloadFailure(null);
    try {
      await saveArchive(sessionClient(), agentId, version, platform);
    } catch (error) {
      if (generation.current !== mine) return;
      const failed = checkFailure(platform, error);
      setDownloadFailure(
        failed.kind === 'refused' ? platformRefusalText(failed.code, strings) : strings.unavailable,
      );
    } finally {
      if (generation.current === mine) setDownloading(false);
    }
  }

  const items = state.kind === 'ready' ? state.listing.items : [];
  const chosen = items.find((item) => item.number === version);
  const checked =
    check.kind === 'idle' || state.kind !== 'ready'
      ? undefined
      : state.platforms.find((platform) => platform.id === check.platform);

  return (
    <main lang={locale} className="w-full max-w-[1100px] space-y-5 px-8 pt-[26px] pb-[90px]">
      <h1 className="text-[21px]">{strings.heading}</h1>
      {state.kind === 'loading' ? <p className="text-muted">{strings.loading}</p> : null}
      {state.kind === 'failed' ? (
        <p role="alert" className="text-danger">
          {strings.loadFailed}
        </p>
      ) : null}
      {state.kind === 'ready' && chosen === undefined ? (
        <p className="text-[13px] text-muted">{strings.empty}</p>
      ) : null}
      {state.kind === 'ready' && chosen !== undefined ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <label htmlFor="platform-version" className="font-semibold">
              {strings.versionLabel}
            </label>
            <select
              id="platform-version"
              className="rounded border border-border-strong bg-surface px-2 py-1.5"
              value={chosen.number}
              onChange={(event) => {
                chooseVersion(Number(event.target.value));
              }}
            >
              {[...items]
                .sort((a, b) => b.number - a.number)
                .map((item) => (
                  <option key={item.number} value={item.number}>
                    {strings.versionOption(
                      item.number,
                      item.summary,
                      badgesFor(item.number, state.listing.pointers).map((environment) =>
                        environment === 'production' ? strings.badgeProduction : strings.badgeLocal,
                      ),
                    )}
                  </option>
                ))}
            </select>
          </div>
          <PlatformMatrix
            platforms={state.platforms}
            checking={check}
            onCheck={(platform) => {
              void runCheck(platform);
            }}
            strings={strings}
          />
          {downloadFailure === null ? null : (
            <p role="alert" className="text-danger">
              {downloadFailure}
            </p>
          )}
          <PlatformResult
            check={check}
            displayName={checked?.displayName ?? ''}
            agentName={chosen.body.definition.agent.name}
            origin={window.location.origin}
            downloading={downloading}
            onDownload={() => {
              if (check.kind === 'exported') void download(check.platform);
            }}
            strings={strings}
          />
        </>
      ) : null}
    </main>
  );
}
