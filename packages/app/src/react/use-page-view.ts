'use client';
/**
 * The state and the actions of `PageView` (issue #1521): the page and the draft being edited, a
 * save with the `expectedRevisionId` the person read, the revisions drawer, the conflict choices,
 * and the agent actions that open the `AgentPanel` with a prompt naming the page.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from 'react';

import type { PageRecord, PageRevision } from '../db/page-port.js';
import type { RichTextBlock } from '../fields/rich-text.js';
import type { DefinedPages } from '../pages/define-pages.js';
import type { FieldMap } from '../resource.js';
import type { AgentPanelAgent, AgentPanelCompletion } from './agent-panel.js';
import { ResourceProblemError } from './client.js';
import { useAppLocale } from './locale-context.js';
import { appStrings, problemMessage, type AppLocale } from './locale.js';
import { rewritePrompt, summarizePrompt } from './page-actions.js';
import { pageClient, type PageClient } from './page-client.js';
import type { PageConflictReason } from './page-revisions.js';
import type { PageViewProps } from './page-view-props.js';

/** The most pages under it a summary prompt names, so the prompt stays within the run's limit. */
const SUMMARY_CHILDREN_MAX = 50;

/** What the person is editing: the title and the body. */
interface PageDraft {
  readonly title: string;
  readonly blocks: readonly RichTextBlock[];
}

/** An open agent action: the panel's agent and prompt, and its key so a new action starts afresh. */
interface PageAction {
  readonly key: number;
  readonly agent: string;
  readonly prompt: string;
}

/** The revisions drawer's state: what it shows, and the cursor of the next page. */
interface PageDrawer {
  readonly open: boolean;
  readonly items: readonly PageRevision[] | null;
  readonly nextCursor: string | null;
}

const CLOSED: PageDrawer = { open: false, items: null, nextCursor: null };

function codeOf(error: unknown): string {
  return error instanceof ResourceProblemError ? error.code : 'other';
}

export function titleOf(page: PageRecord): string {
  return String(page['title']);
}

function blocksOf(page: PageRecord): readonly RichTextBlock[] {
  return page['blocks'] as readonly RichTextBlock[];
}

/** Keeps the latest drawer-open flag where a write that answers later can read it. */
function useDrawerOpenRef(open: boolean): { readonly current: boolean } {
  const ref = useRef(false);
  useEffect(() => {
    ref.current = open;
  }, [open]);
  return ref;
}

/** The revisions drawer: its state, and loading its pages. */
function useRevisionsDrawer(
  client: PageClient,
  id: string,
  fail: (error: unknown) => void,
): {
  readonly drawer: PageDrawer;
  readonly setDrawer: Dispatch<SetStateAction<PageDrawer>>;
  readonly drawerOpen: { readonly current: boolean };
  readonly loadRevisions: (cursor?: string | null) => void;
} {
  const [drawer, setDrawer] = useState<PageDrawer>(CLOSED);
  const drawerOpen = useDrawerOpenRef(drawer.open);
  const loadRevisions = useCallback(
    (cursor: string | null = null) => {
      client.revisions(id, { cursor }).then(
        (found) =>
          setDrawer((current) => ({
            open: current.open,
            items: cursor === null ? found.items : [...(current.items ?? []), ...found.items],
            nextCursor: found.nextCursor,
          })),
        fail,
      );
    },
    [client, id, fail],
  );
  return { drawer, setDrawer, drawerOpen, loadRevisions };
}

/** The agent actions: the open action for the panel, and the runs' agents by run id. */
function useAgentActions<F extends FieldMap>(
  context: {
    readonly client: PageClient<F>;
    readonly resource: DefinedPages<F>;
    readonly locale: AppLocale;
    readonly page: PageRecord<F> | null;
  },
  fail: (error: unknown) => void,
) {
  const { client, resource, locale, page } = context;
  const [action, setAction] = useState<PageAction | null>(null);
  const [agentNames, setAgentNames] = useState<ReadonlyMap<string, string>>(new Map());
  const open = (agent: AgentPanelAgent, prompt: string): void =>
    setAction((current) => ({ key: (current?.key ?? 0) + 1, agent: agent.name, prompt }));
  const promptContext = { name: resource.name, locale };

  const rewrite = (agent: AgentPanelAgent): void => {
    if (page === null) return;
    open(
      agent,
      rewritePrompt({ id: page.id, title: titleOf(page) }, page.revision_id, promptContext),
    );
  };

  const summarize = (agent: AgentPanelAgent): void => {
    if (page === null) return;
    client.children(page.id).then((children) => {
      const childIds = children.slice(0, SUMMARY_CHILDREN_MAX).map((child) => child.id);
      open(agent, summarizePrompt({ id: page.id, title: titleOf(page) }, childIds, promptContext));
    }, fail);
  };

  const rememberAgent = (runId: string, label: string): void =>
    setAgentNames((current) => new Map([...current, [runId, label]]));
  return { action, setAction, agentNames, rememberAgent, rewrite, summarize };
}

/** Everything `PageView` draws and does, for one page of `props.resource`. */
export function usePageView<F extends FieldMap>(props: PageViewProps<F>) {
  const { resource, id, agents = [], onChanged } = props;
  const locale = useAppLocale(props.locale);
  const appText = appStrings(locale);
  const strings = appText.pages;
  const client = useMemo(() => props.client ?? pageClient(resource), [props.client, resource]);
  const [page, setPage] = useState<PageRecord<F> | null>(null);
  const [draft, setDraft] = useState<PageDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState<PageConflictReason | null>(null);

  const fail = useCallback(
    (error: unknown) => {
      if (codeOf(error) === 'page_conflict') setConflict('conflict');
      else setProblem(problemMessage(appText, codeOf(error)));
    },
    [appText],
  );
  const { drawer, setDrawer, drawerOpen, loadRevisions } = useRevisionsDrawer(client, id, fail);
  const { action, setAction, agentNames, rememberAgent, rewrite, summarize } = useAgentActions(
    { client, resource, locale, page },
    fail,
  );

  /** Shows `found` as the page and as what is being edited. */
  const show = useCallback((found: PageRecord<F>) => {
    setPage(found);
    setDraft({ title: titleOf(found), blocks: blocksOf(found) });
    setDirty(false);
    setConflict(null);
    setProblem(null);
  }, []);

  const load = useCallback(
    () =>
      client.get(id).then((found) => {
        show(found);
        return found;
      }),
    [client, id, show],
  );
  useEffect(() => {
    setDrawer(CLOSED);
    setAction(null);
    load().catch(fail);
  }, [load, fail, setDrawer]);

  /** After the page changed: the drawer read again when open, and the page told. */
  const changed = (found: PageRecord<F>, said: string | null): void => {
    setStatus(said);
    if (drawerOpen.current) loadRevisions();
    onChanged?.(found);
  };

  /** Runs a write that answers with the page, showing it and telling the page `said`. */
  const write = (request: Promise<PageRecord<F>>, said: string, clearProblem: boolean): void => {
    setBusy(true);
    if (clearProblem) setProblem(null);
    request
      .then((written) => {
        show(written);
        changed(written, said);
      }, fail)
      .finally(() => setBusy(false));
  };

  const save = (expectedRevisionId: string): void => {
    if (draft === null) return;
    write(
      client.update(id, { title: draft.title, blocks: draft.blocks, expectedRevisionId }),
      strings.saved,
      true,
    );
  };

  const restore = (revision: PageRevision): void => {
    if (page === null) return;
    write(
      client.restore(id, revision.id, { expectedRevisionId: page.revision_id }),
      strings.restored,
      false,
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (page !== null) save(page.revision_id);
  };

  const keepMine = (): void => {
    client.get(id).then((latest) => {
      setPage(latest);
      save(latest.revision_id);
    }, fail);
  };

  const loadLatest = (): void => {
    load().catch(fail);
  };

  const onCompleted = ({ runId, agent }: AgentPanelCompletion): void => {
    rememberAgent(runId, agent.label);
    if (dirty) {
      setConflict('agent');
      return;
    }
    load()
      .then((found) => changed(found, null))
      .catch(fail);
  };

  const edit = (change: Partial<PageDraft>): void => {
    if (draft === null) return;
    setDraft({ ...draft, ...change });
    setDirty(true);
  };

  const toggleDrawer = (): void => {
    const opening = !drawer.open;
    setDrawer({ ...drawer, open: opening });
    if (opening) loadRevisions();
  };

  return {
    locale,
    appText,
    strings,
    agents,
    page,
    draft,
    busy,
    status,
    problem,
    conflict,
    drawer,
    action,
    agentNames,
    edit,
    submit,
    keepMine,
    loadLatest,
    restore,
    onCompleted,
    rewrite,
    summarize,
    toggleDrawer,
    loadMore: () => loadRevisions(drawer.nextCursor),
  };
}
