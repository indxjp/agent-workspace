'use client';

import { useEffect, useState } from 'react';

import type { EngineDescriptor } from '../../contracts/engines';
import { browserClient } from '../../lib/browser-client';
import { agentDetailStrings, type AgentDetailStrings } from './agent-detail-messages';
import { problemText } from './agent-detail-save-report';
import { loadEngines } from './agent-requests-model';
import { ProblemLine } from './problem-line';
import type { VersionsLocale } from './versions-messages';

/** What `GET /api/engines` has told this screen so far. */
export type EngineCatalogState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly engines: readonly EngineDescriptor[] }
  | { readonly kind: 'failed'; readonly reason: string };

/** The installed engines with what each can honour, and the read-only note under them. */
function InstalledEngines({
  installed,
  words,
}: Readonly<{ installed: readonly EngineDescriptor[]; words: AgentDetailStrings }>) {
  return (
    <>
      <ul className="text-[13px] text-text">
        {installed.map((engine) => (
          <li key={engine.id}>
            {engine.displayName} <span className="text-muted">({engine.id})</span>,{' '}
            {words.engineVersion(engine.version)}
            {engine.capabilities.skills ? null : (
              <span className="text-muted">{words.skillsUnavailable}</span>
            )}
            {engine.capabilities.mcp ? null : (
              <span className="text-muted">{words.connectorsUnavailable}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12.5px] text-muted">
        {words.engineReadOnlyBefore}
        <code>aw agents update --engine</code>
        {words.engineReadOnlyAfter}
      </p>
    </>
  );
}

/** The body of the engine section for whichever of the four catalog states it is in. */
function EngineBody({
  catalog,
  locale,
  words,
}: Readonly<{ catalog: EngineCatalogState; locale: VersionsLocale; words: AgentDetailStrings }>) {
  if (catalog.kind === 'loading') {
    return <p className="text-[13px] text-muted">{words.loadingEngines}</p>;
  }
  if (catalog.kind === 'failed') {
    return (
      <p className="text-[13px] text-danger" role="alert">
        <ProblemLine
          locale={locale}
          english={catalog.reason}
          lead={words.enginesFailed}
          detail={catalog.reason}
        />
      </p>
    );
  }
  const installed = catalog.engines.filter((engine) => engine.installed);
  if (installed.length === 0) {
    return (
      <p className="text-[13px] text-danger" role="alert">
        {words.noEngine}
      </p>
    );
  }
  return <InstalledEngines installed={installed} words={words} />;
}

/**
 * Issue #319 (ENG-02c): the engine an agent runs on, shown and not offered as a choice.
 *
 * The section is **read-only on purpose**, and the reason is a fact about the deployment rather
 * than an unfinished control: an agent's engine is the discriminant of its policy, and switching it
 * rewrites the policy's engine-native half. ENG-09 (#308) published the second engine
 * (`openai-agents`) without a picker — that is a product decision the unit did not take — so the
 * arm is set deliberately with `aw agents update --engine`, and this list says what each installed
 * engine can honour. An engine that declares `skills: false` is marked as such, because a skill
 * assigned below is then refused (`422 engine_capability_unsupported`) rather than ignored; an
 * engine that declares `mcp: false` (`pi`, ENG-08 #307) is marked for its connectors the same way.
 * An engine that honours both (`mastra`, ENG-10 #309) carries no marker.
 *
 * The four states are the four `GET /api/engines` can produce, and there is no fifth: a
 * deployment with no installed engine is called out rather than rendered as an empty list, because
 * it is the one state in which no agent on this screen can run at all.
 *
 * Exported and pure, for the same reason `AgentModelSection` is: a screen driven by fetch effects
 * can only be asserted in its pre-fetch state by a static render, so the states that matter are
 * tested against this component with `catalog` supplied by the test.
 */
export function AgentEngineSection({
  catalog,
  locale = 'en',
}: Readonly<{
  catalog: EngineCatalogState;
  /** The reader's language; English when absent. */
  locale?: VersionsLocale;
}>) {
  const words = agentDetailStrings(locale);
  return (
    <section
      className="rounded-(--radius) border border-border bg-surface p-4"
      aria-labelledby="engine-heading"
    >
      <h2 id="engine-heading" className="mb-1 text-[15px] font-semibold">
        {words.engine}
      </h2>
      <p className="mb-3 text-[12.5px] text-muted">{words.engineHelp}</p>
      <EngineBody catalog={catalog} locale={locale} words={words} />
    </section>
  );
}

/** `GET /api/engines`, read once per mount. */
export function useEngineCatalog(): EngineCatalogState {
  const [state, setState] = useState<EngineCatalogState>({ kind: 'loading' });
  useEffect(() => {
    let active = true;
    void loadEngines(browserClient()).then((result) => {
      if (!active) return;
      setState(
        result.ok
          ? { kind: 'ready', engines: result.value }
          : { kind: 'failed', reason: problemText(result.problem) },
      );
    });
    return () => {
      active = false;
    };
  }, []);
  return state;
}
