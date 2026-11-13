/**
 * The resource pages' own words, in each language an app page may speak (issue #1508). Every
 * visible string the four resource parts own is here: the list, the board, the form and the
 * detail, since issue #1509 the agent panel's, and since issue #1514 the recipe graph's and the
 * recipe run list's, since issue #1522 the dashboard's, since issue #1519 the channel view's, and
 * since issue #1521 the page tree's, the block editor's and the page view's. Pure, with no React,
 * so a server component reads the same words as the client.
 *
 * Field names and enum values are the app's own words, not the kit's: a part shows them
 * humanised (`in_progress` → `In progress`) unless the page passes its own labels.
 */
import type { SurfaceLocale } from '@indx-workspace/contracts/surfaces';

/** The languages an app page speaks: the hosted surface's, so one `theme.locale` sets both. */
export type AppLocale = SurfaceLocale;

/** The resource parts' strings in one language. */
export interface AppStrings {
  /** The accessible name of the list's table, naming the resource's plural. */
  readonly listLabel: (plural: string) => string;
  /** The row of a list with no records. */
  readonly emptyList: string;
  /** The button that fetches the next page. */
  readonly loadMore: string;
  /** Announced while a page is loading. */
  readonly loading: string;
  /** Announced when a page could not be loaded; the retry button follows it. */
  readonly loadFailed: string;
  /** The button that repeats the request that failed. */
  readonly retry: string;
  /** The accessible name of the filter group. */
  readonly filtersLabel: string;
  /** The choice of a filter that filters nothing. */
  readonly filterAny: string;
  /** The accessible name of the board, naming the field its columns are the values of. */
  readonly boardLabel: (field: string) => string;
  /** The line in a board column with no cards. */
  readonly emptyColumn: string;
  /** How many cards a board column holds. */
  readonly cardCount: (count: number) => string;
  /** What an unset value reads as. */
  readonly noValue: string;
  /** A `bool()` field's two values. */
  readonly yes: string;
  readonly no: string;
  /** A `files()` field's cell: how many files it holds. */
  readonly fileCount: (count: number) => string;
  /** Appended to a required control's label, for every reader. */
  readonly required: string;
  /** The hint under a `tags()` control. */
  readonly tagsHint: string;
  /** The hint under a `richText()` control: one paragraph per line. */
  readonly richTextHint: string;
  /** The accessible name of the button that takes one file off the record. */
  readonly removeFile: (name: string) => string;
  /** The form's submit button, and what it says while saving. */
  readonly save: string;
  readonly saving: string;
  /** The form's cancel link. */
  readonly cancel: string;
  /** A control whose value is missing. */
  readonly fieldRequired: string;
  /** A control whose value is not one the field accepts. */
  readonly fieldInvalid: string;
  /** The form-level alert's heading when the record could not be saved. */
  readonly saveFailed: string;
  /** The form-level alert's line when some fields need attention. */
  readonly checkFields: string;
  /** What a problem code means for the person, by code; {@link problemMessage} picks one. */
  readonly problems: {
    readonly unauthenticated: string;
    readonly forbidden: string;
    readonly resource_not_found: string;
    readonly transport_failed: string;
    readonly other: string;
  };
  /** The detail's heading of its field list. */
  readonly fieldsHeading: string;
  /** The accessible name of the history slot. */
  readonly historyLabel: string;
  /** The accessible name of the aside slot (the agent panel). */
  readonly asideLabel: string;
  /** The detail's edit link. */
  readonly edit: string;
  /** The agent panel's words (issue #1509). */
  readonly agentPanel: AgentPanelStrings;
  /** The recipe graph's and the recipe run list's words (issue #1514). */
  readonly recipes: RecipeStrings;
  /** The dashboard's words (issue #1522). */
  readonly dashboard: DashboardStrings;
  /** The channel view's words (issue #1519). */
  readonly channel: ChannelStrings;
  /** The page tree's, the block editor's and the page view's words (issue #1521). */
  readonly pages: PageStrings;
}

/** The channel view's words: the message list, the thread pane, the composer and presence. */
export interface ChannelStrings {
  /** The accessible name of the whole channel view. */
  readonly channelLabel: string;
  /** The accessible name of the message list. */
  readonly messagesLabel: string;
  /** The line of a channel with no messages. */
  readonly noMessages: string;
  /** The presence row's name, and its line when no one is connected. */
  readonly presenceLabel: string;
  readonly nobodyHere: string;
  /** The composer's label in the channel, and in a thread. */
  readonly composerLabel: string;
  readonly replyLabel: string;
  /** The send button, and what it says while sending. */
  readonly send: string;
  readonly sending: string;
  /** The alert when a message could not be sent. */
  readonly sendFailed: string;
  /** The accessible name of the mention suggestions, and of one suggestion's button. */
  readonly mentionsLabel: string;
  readonly mentionLabel: (name: string) => string;
  /** The file picker's label, and the line while a file uploads or after one failed. */
  readonly attach: string;
  readonly uploading: string;
  readonly uploadFailed: string;
  /** A message's button that opens its thread: how many replies it has. */
  readonly openThread: (replies: number) => string;
  /** The accessible name of the thread pane, and its close button. */
  readonly threadLabel: string;
  readonly closeThread: string;
  /** What following the channel's stream says while it is not live. */
  readonly connecting: string;
  readonly reconnecting: string;
  readonly lost: string;
}

/** The words of the wiki's parts: `PageTree`, `RichText` and `PageView`. */
export interface PageStrings {
  /** The tree's accessible name, its empty line, and its buttons. */
  readonly treeLabel: string;
  readonly noPages: string;
  readonly newPage: string;
  /** The title a new page starts with. */
  readonly untitled: string;
  /** The "Move to…" button, its dialog's heading naming the page, and the dialog's controls. */
  readonly moveTo: string;
  readonly moveHeading: (title: string) => string;
  readonly moveUnder: string;
  readonly topLevel: string;
  readonly move: string;
  /** Refused before asking: the target is the page itself or below it. */
  readonly moveIntoItself: string;
  /** The page's title control, and the accessible name of its body. */
  readonly titleLabel: string;
  readonly bodyLabel: string;
  /** How the editor's keys work, under the body. */
  readonly editorHint: string;
  /** A block's type select and text box, naming the block by its place. */
  readonly blockTypeLabel: (place: number) => string;
  readonly blockTextLabel: (place: number, type: string) => string;
  /** What each block type reads as. */
  readonly blockTypes: {
    readonly paragraph: string;
    readonly heading1: string;
    readonly heading2: string;
    readonly heading3: string;
    readonly bulleted_item: string;
    readonly numbered_item: string;
    readonly quote: string;
    readonly code: string;
    readonly divider: string;
  };
  readonly addBlock: string;
  readonly removeBlock: (place: number) => string;
  /** Under a list item: how many nested items it carries. */
  readonly nestedItems: (count: number) => string;
  /** Announced after a save and after a restore. */
  readonly saved: string;
  readonly restored: string;
  /** The conflict notice: its heading, its lines, and its two choices. */
  readonly conflictHeading: string;
  readonly conflictBody: string;
  readonly agentChangedBody: string;
  readonly loadLatest: string;
  readonly keepMine: string;
  /** The revisions drawer: its toggle, heading and empty line. */
  readonly showRevisions: string;
  readonly hideRevisions: string;
  readonly revisionsHeading: string;
  readonly noRevisions: string;
  /** Who saved a revision: a person by name, or an agent, badged. */
  readonly savedBy: (name: string) => string;
  readonly person: (principalId: string) => string;
  readonly agentBadge: string;
  readonly anAgent: string;
  /** A revision's link to its run, its preview, and its restore button naming its time. */
  readonly openRunLabel: (runId: string) => string;
  readonly preview: string;
  readonly current: string;
  readonly restore: string;
  readonly restoreLabel: (time: string) => string;
  /** The accessible name of the agent actions, and each action. */
  readonly actionsLabel: string;
  readonly rewriteWith: (agent: string) => string;
  readonly summarizeIntoNewPage: string;
  /** What a refusal of the page routes means for the person, by code. */
  readonly problems: {
    readonly page_conflict: string;
    readonly page_cycle: string;
    readonly page_space_mismatch: string;
    readonly page_has_children: string;
    readonly revision_not_found: string;
  };
}

/** The dashboard's words: J5's four lists. */
export interface DashboardStrings {
  /** The heading of each list. */
  readonly runningHeading: string;
  readonly waitingHeading: string;
  readonly failedHeading: string;
  readonly spendHeading: string;
  /** The line of each list when it is empty. */
  readonly noRunning: string;
  readonly noWaiting: string;
  readonly noFailed: string;
  readonly noSpend: string;
  /** The column headings. */
  readonly runColumn: string;
  readonly agentColumn: string;
  readonly statusColumn: string;
  readonly startedColumn: string;
  readonly waitingOnColumn: string;
  readonly errorColumn: string;
  readonly currencyColumn: string;
  readonly amountColumn: string;
  readonly runsColumn: string;
  readonly unsettledColumn: string;
  /** The accessible name of a row's link to its run in the Agent Workspace console. */
  readonly openRunLabel: (runId: string) => string;
  /** A team member's run, naming its lead run (ADR-0104). */
  readonly partOfRun: (leadRunId: string) => string;
  /** What a run's status reads as, by status. */
  readonly runStatus: {
    readonly queued: string;
    readonly running: string;
    readonly awaiting_approval: string;
    readonly completed: string;
    readonly failed: string;
    readonly cancelled: string;
  };
  /** The spend list's line until a spend ceiling exists to compare against. */
  readonly noCeiling: string;
  /** Under a list that stopped at a page: there are more runs than it shows. */
  readonly truncated: string;
  /** When the lists were read, as a time of day. */
  readonly updatedAt: (time: string) => string;
}

/** The recipe graph's and the recipe run list's words. */
export interface RecipeStrings {
  /** The accessible name of a run's list of steps, naming the recipe. */
  readonly stepsLabel: (recipe: string) => string;
  /** The line of a run that has no step yet. */
  readonly noSteps: string;
  /** What a recipe run's status reads as, by status. */
  readonly runStatus: {
    readonly running: string;
    readonly waiting: string;
    readonly completed: string;
    readonly failed: string;
    readonly cancelled: string;
  };
  /** What a step's status reads as, by status. */
  readonly stepStatus: {
    readonly running: string;
    readonly awaiting_approval: string;
    readonly completed: string;
    readonly failed: string;
  };
  /** The terms of a step's facts. */
  readonly duration: string;
  readonly cost: string;
  /** What a fact that is not known yet reads as. */
  readonly unknown: string;
  /** A step's or a run's failure, with its public code. */
  readonly failedWith: (code: string) => string;
  /** The link to a step's run in Agent Workspace, and its accessible name naming the step. */
  readonly openRun: string;
  readonly openRunLabel: (step: string) => string;
  /** The heading of the call a paused step waits on, and the term of its tool. */
  readonly pendingCall: string;
  readonly tool: string;
  /** The decision buttons, their accessible names naming the step, and what they say meanwhile. */
  readonly approve: string;
  readonly reject: string;
  readonly approveLabel: (step: string) => string;
  readonly rejectLabel: (step: string) => string;
  readonly deciding: string;
  /** Announced when a poll finds a step's status changed. */
  readonly stepChanged: (step: string, status: string) => string;
  /** Announced when a poll finds the run's status changed. */
  readonly runChanged: (status: string) => string;
  /** The recipe run list: its accessible name, column headings and empty line. */
  readonly runsLabel: string;
  readonly recipeColumn: string;
  readonly statusColumn: string;
  readonly startedColumn: string;
  readonly noRuns: string;
  /** What a refusal of the recipe routes means for the person, by code. */
  readonly problems: {
    readonly recipe_run_not_found: string;
    readonly recipe_step_not_awaiting_approval: string;
    readonly approval_already_decided: string;
    readonly approval_expired: string;
    readonly recipes_unavailable: string;
  };
}

/** The agent panel's words. */
export interface AgentPanelStrings {
  /** The panel's heading. */
  readonly heading: string;
  /** The label of the agent picker. */
  readonly agentLabel: string;
  /** The label of the prompt box. */
  readonly promptLabel: string;
  /** The send button, and what it says while the prompt is being sent. */
  readonly send: string;
  readonly sending: string;
  /** The accessible name of the transcript. */
  readonly transcriptLabel: string;
  /** The line of a panel with no conversation yet. */
  readonly emptyTranscript: string;
  /** The name above the person's own messages. */
  readonly you: string;
  /** What a run's status reads as, by status. */
  readonly status: {
    readonly queued: string;
    readonly running: string;
    readonly awaiting_approval: string;
    readonly completed: string;
    readonly failed: string;
    readonly cancelled: string;
  };
  /** The tool trace's summary, and the headings of a step's input and output. */
  readonly toolActivity: (count: number) => string;
  readonly toolInput: string;
  readonly toolOutput: string;
  /** Shown when the run waits for an approval and the page draws no approval prompt. */
  readonly awaitingInConsole: string;
  /** The button that asks again whether the run is still waiting. */
  readonly checkAgain: string;
  /** The heading of a failed run's notice. */
  readonly runFailed: string;
  /** What a refusal of the panel's routes means for the person, by code. */
  readonly problems: {
    readonly session_busy: string;
    readonly agent_not_offered: string;
    readonly stream_lost: string;
  };
}

const EN: AppStrings = {
  listLabel: (plural) => plural,
  emptyList: 'Nothing here yet.',
  loadMore: 'Load more',
  loading: 'Loading…',
  loadFailed: 'This page could not be loaded.',
  retry: 'Try again',
  filtersLabel: 'Filters',
  filterAny: 'Any',
  boardLabel: (field) => `Board by ${field}`,
  emptyColumn: 'No cards',
  cardCount: (count) => (count === 1 ? '1 card' : `${String(count)} cards`),
  noValue: '—',
  yes: 'Yes',
  no: 'No',
  fileCount: (count) => (count === 1 ? '1 file' : `${String(count)} files`),
  required: '(required)',
  tagsHint: 'Separate tags with commas.',
  richTextHint: 'One paragraph per line.',
  removeFile: (name) => `Remove ${name}`,
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  fieldRequired: 'Enter a value.',
  fieldInvalid: 'Check this value.',
  saveFailed: 'The record was not saved.',
  checkFields: 'Some fields need attention.',
  problems: {
    unauthenticated: 'Your sign-in has ended. Sign in again, then try again.',
    forbidden: 'You do not have permission to do this.',
    resource_not_found: 'This record no longer exists, or you cannot see it.',
    transport_failed: 'The app could not be reached. Check your connection and try again.',
    other: 'Something went wrong. Try again.',
  },
  fieldsHeading: 'Details',
  historyLabel: 'History',
  asideLabel: 'Assistant',
  edit: 'Edit',
  agentPanel: {
    heading: 'Ask an agent',
    agentLabel: 'Agent',
    promptLabel: 'What should the agent do with this record?',
    send: 'Send',
    sending: 'Sending…',
    transcriptLabel: 'Conversation with the agent',
    emptyTranscript: 'Choose an agent and tell it what to do with this record.',
    you: 'You',
    status: {
      queued: 'Queued',
      running: 'Working',
      awaiting_approval: 'Awaiting approval',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    toolActivity: (count) => (count === 1 ? '1 step' : `${String(count)} steps`),
    toolInput: 'Input',
    toolOutput: 'Output',
    awaitingInConsole:
      'The agent is waiting for your approval. Decide it in Agent Workspace, then check again here.',
    checkAgain: 'Check again',
    runFailed: 'The agent could not finish.',
    problems: {
      session_busy:
        'The agent is still working on this record. Wait for it to finish, then send again.',
      agent_not_offered: 'This agent is not offered on this record.',
      stream_lost: 'The connection to the agent was lost. Check again in a moment.',
    },
  },
  recipes: {
    stepsLabel: (recipe) => `Steps of ${recipe}`,
    noSteps: 'No step has started yet.',
    runStatus: {
      running: 'Running',
      waiting: 'Waiting for a decision',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    stepStatus: {
      running: 'Running',
      awaiting_approval: 'Awaiting approval',
      completed: 'Completed',
      failed: 'Failed',
    },
    duration: 'Duration',
    cost: 'Cost',
    unknown: 'Not known yet',
    failedWith: (code) => `Failed: ${code}`,
    openRun: 'Open run',
    openRunLabel: (step) => `Open run of step ${step} in Agent Workspace`,
    pendingCall: 'Waiting for your approval of this call',
    tool: 'Tool',
    approve: 'Approve',
    reject: 'Reject',
    approveLabel: (step) => `Approve step ${step}`,
    rejectLabel: (step) => `Reject step ${step}`,
    deciding: 'Sending your decision…',
    stepChanged: (step, status) => `Step ${step}: ${status}.`,
    runChanged: (status) => `Recipe: ${status}.`,
    runsLabel: 'Recipe runs',
    recipeColumn: 'Recipe',
    statusColumn: 'Status',
    startedColumn: 'Started',
    noRuns: 'No recipe has run yet.',
    problems: {
      recipe_run_not_found: 'This recipe run does not exist, or it is not of your workspace.',
      recipe_step_not_awaiting_approval: 'This step is no longer waiting for a decision.',
      approval_already_decided: 'Someone already decided this step.',
      approval_expired: 'The approval expired before a decision was made.',
      recipes_unavailable: 'The recipes are not running in this app right now. Try again later.',
    },
  },
  dashboard: {
    runningHeading: 'Running now',
    waitingHeading: 'Waiting for a decision',
    failedHeading: 'Failed in the last 24 hours',
    spendHeading: 'Spend today',
    noRunning: 'No agent is running right now.',
    noWaiting: 'Nothing is waiting for a decision.',
    noFailed: 'No run failed in the last 24 hours.',
    noSpend: 'No run has started today.',
    runColumn: 'Run',
    agentColumn: 'Agent',
    statusColumn: 'Status',
    startedColumn: 'Started',
    waitingOnColumn: 'Waiting on',
    errorColumn: 'Error',
    currencyColumn: 'Currency',
    amountColumn: 'Spend',
    runsColumn: 'Runs',
    unsettledColumn: 'Not settled yet',
    openRunLabel: (runId) => `Open run ${runId}`,
    partOfRun: (leadRunId) => `Part of run ${leadRunId}`,
    runStatus: {
      queued: 'Queued',
      running: 'Running',
      awaiting_approval: 'Awaiting approval',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    noCeiling: 'No spend ceiling is configured.',
    truncated: 'There are more runs than this list shows; the console has all of them.',
    updatedAt: (time) => `Updated at ${time}`,
  },
  channel: {
    channelLabel: 'Channel',
    messagesLabel: 'Messages',
    noMessages: 'No messages yet. Write the first one.',
    presenceLabel: 'Here now',
    nobodyHere: 'No one is here right now.',
    composerLabel: 'Message',
    replyLabel: 'Reply in thread',
    send: 'Send',
    sending: 'Sending…',
    sendFailed: 'The message could not be sent.',
    mentionsLabel: 'Mention someone',
    mentionLabel: (name) => `Mention ${name}`,
    attach: 'Attach a file',
    uploading: 'Uploading the file…',
    uploadFailed: 'The file could not be uploaded.',
    openThread: (replies) =>
      replies === 0
        ? 'Reply'
        : replies === 1
          ? 'Open thread, 1 reply'
          : `Open thread, ${String(replies)} replies`,
    threadLabel: 'Thread',
    closeThread: 'Close thread',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    lost: 'The connection was lost. Reload the page to see new messages.',
  },
  pages: {
    treeLabel: 'Pages',
    noPages: 'No pages yet.',
    newPage: 'New page',
    untitled: 'Untitled',
    moveTo: 'Move to…',
    moveHeading: (title) => `Move ${title}`,
    moveUnder: 'Move under',
    topLevel: 'The top level',
    move: 'Move',
    moveIntoItself: 'A page cannot move under itself or under a page below it.',
    titleLabel: 'Title',
    bodyLabel: 'Page body',
    editorHint:
      'Enter at the end of a block starts a new one, Backspace at its start joins it to the one before, and Alt+Up or Alt+Down moves it.',
    blockTypeLabel: (place) => `Block ${String(place)} type`,
    blockTextLabel: (place, type) => `Block ${String(place)} text (${type})`,
    blockTypes: {
      paragraph: 'Paragraph',
      heading1: 'Heading 1',
      heading2: 'Heading 2',
      heading3: 'Heading 3',
      bulleted_item: 'Bulleted item',
      numbered_item: 'Numbered item',
      quote: 'Quote',
      code: 'Code',
      divider: 'Divider',
    },
    addBlock: 'Add block',
    removeBlock: (place) => `Remove block ${String(place)}`,
    nestedItems: (count) => (count === 1 ? '1 nested item' : `${String(count)} nested items`),
    saved: 'Saved.',
    restored: 'The revision is restored as the newest one.',
    conflictHeading: 'This page changed since you opened it.',
    conflictBody:
      'Load the latest version and lose your changes, or keep yours and save them over it.',
    agentChangedBody:
      'An agent changed this page while you were editing it. Load the latest version, or keep yours and save them over it.',
    loadLatest: 'Load latest',
    keepMine: 'Keep mine',
    showRevisions: 'Show revisions',
    hideRevisions: 'Hide revisions',
    revisionsHeading: 'Revisions',
    noRevisions: 'No revision yet.',
    savedBy: (name) => `Saved by ${name}`,
    person: (principalId) => `Person ${principalId.slice(0, 8)}`,
    agentBadge: 'Agent',
    anAgent: 'An agent',
    openRunLabel: (runId) => `Open run ${runId}`,
    preview: 'Preview',
    current: 'Current',
    restore: 'Restore',
    restoreLabel: (time) => `Restore the revision of ${time}`,
    actionsLabel: 'Agent actions',
    rewriteWith: (agent) => `Rewrite with ${agent}`,
    summarizeIntoNewPage: 'Summarize into new page',
    problems: {
      page_conflict: 'This page changed since you opened it.',
      page_cycle: 'A page cannot move under itself or under a page below it.',
      page_space_mismatch: 'A page can only move within its own space.',
      page_has_children: 'This page has pages under it. Move or delete them first.',
      revision_not_found: 'This revision no longer exists.',
    },
  },
};

const JA: AppStrings = {
  listLabel: (plural) => plural,
  emptyList: 'まだ何もありません。',
  loadMore: 'さらに読み込む',
  loading: '読み込み中…',
  loadFailed: 'このページを読み込めませんでした。',
  retry: '再試行',
  filtersLabel: '絞り込み',
  filterAny: 'すべて',
  boardLabel: (field) => `${field}別のボード`,
  emptyColumn: 'カードはありません',
  cardCount: (count) => `${String(count)} 件`,
  noValue: '—',
  yes: 'はい',
  no: 'いいえ',
  fileCount: (count) => `ファイル ${String(count)} 件`,
  required: '（必須）',
  tagsHint: 'タグはカンマで区切ってください。',
  richTextHint: '1 行が 1 段落になります。',
  removeFile: (name) => `${name}を削除`,
  save: '保存',
  saving: '保存中…',
  cancel: 'キャンセル',
  fieldRequired: '値を入力してください。',
  fieldInvalid: 'この値を確認してください。',
  saveFailed: 'レコードを保存できませんでした。',
  checkFields: '確認が必要な項目があります。',
  problems: {
    unauthenticated:
      'サインインの有効期限が切れました。もう一度サインインしてから再試行してください。',
    forbidden: 'この操作を行う権限がありません。',
    resource_not_found: 'このレコードは存在しないか、表示する権限がありません。',
    transport_failed: 'アプリに接続できませんでした。接続を確認して再試行してください。',
    other: '問題が発生しました。再試行してください。',
  },
  fieldsHeading: '詳細',
  historyLabel: '履歴',
  asideLabel: 'アシスタント',
  edit: '編集',
  agentPanel: {
    heading: 'エージェントに依頼',
    agentLabel: 'エージェント',
    promptLabel: 'このレコードについてエージェントに依頼する内容',
    send: '送信',
    sending: '送信中…',
    transcriptLabel: 'エージェントとの会話',
    emptyTranscript: 'エージェントを選び、このレコードについて依頼する内容を入力してください。',
    you: 'あなた',
    status: {
      queued: '待機中',
      running: '作業中',
      awaiting_approval: '承認待ち',
      completed: '完了',
      failed: '失敗',
      cancelled: 'キャンセル済み',
    },
    toolActivity: (count) => `${String(count)} ステップ`,
    toolInput: '入力',
    toolOutput: '出力',
    awaitingInConsole:
      'エージェントがあなたの承認を待っています。Agent Workspace で承認または却下してから、ここで再確認してください。',
    checkAgain: '再確認',
    runFailed: 'エージェントは作業を完了できませんでした。',
    problems: {
      session_busy:
        'エージェントはまだこのレコードの作業中です。完了してから、もう一度送信してください。',
      agent_not_offered: 'このエージェントはこのレコードでは利用できません。',
      stream_lost: 'エージェントとの接続が切れました。しばらくしてから再確認してください。',
    },
  },
  recipes: {
    stepsLabel: (recipe) => `${recipe}のステップ`,
    noSteps: 'まだ開始したステップはありません。',
    runStatus: {
      running: '実行中',
      waiting: '判断待ち',
      completed: '完了',
      failed: '失敗',
      cancelled: 'キャンセル済み',
    },
    stepStatus: {
      running: '実行中',
      awaiting_approval: '承認待ち',
      completed: '完了',
      failed: '失敗',
    },
    duration: '所要時間',
    cost: 'コスト',
    unknown: 'まだ不明',
    failedWith: (code) => `失敗：${code}`,
    openRun: 'ランを開く',
    openRunLabel: (step) => `ランを開く：ステップ ${step}（Agent Workspace）`,
    pendingCall: 'この呼び出しの承認を待っています',
    tool: 'ツール',
    approve: '承認',
    reject: '却下',
    approveLabel: (step) => `ステップ ${step} を承認`,
    rejectLabel: (step) => `ステップ ${step} を却下`,
    deciding: '判断を送信中…',
    stepChanged: (step, status) => `ステップ ${step}：${status}。`,
    runChanged: (status) => `レシピ：${status}。`,
    runsLabel: 'レシピの実行',
    recipeColumn: 'レシピ',
    statusColumn: '状態',
    startedColumn: '開始日時',
    noRuns: 'まだ実行されたレシピはありません。',
    problems: {
      recipe_run_not_found:
        'このレシピの実行は存在しないか、あなたのワークスペースのものではありません。',
      recipe_step_not_awaiting_approval: 'このステップはもう判断を待っていません。',
      approval_already_decided: 'このステップはすでに他の人が判断しました。',
      approval_expired: '判断される前に承認の期限が切れました。',
      recipes_unavailable:
        '現在このアプリではレシピが動いていません。しばらくしてから再試行してください。',
    },
  },
  dashboard: {
    runningHeading: '実行中',
    waitingHeading: '判断待ち',
    failedHeading: '過去24時間の失敗',
    spendHeading: '本日の利用額',
    noRunning: '現在実行中のエージェントはありません。',
    noWaiting: '判断を待っているものはありません。',
    noFailed: '過去24時間に失敗したランはありません。',
    noSpend: '本日開始したランはありません。',
    runColumn: 'ラン',
    agentColumn: 'エージェント',
    statusColumn: '状態',
    startedColumn: '開始',
    waitingOnColumn: '承認待ちのツール',
    errorColumn: 'エラー',
    currencyColumn: '通貨',
    amountColumn: '利用額',
    runsColumn: 'ラン数',
    unsettledColumn: '未確定',
    openRunLabel: (runId) => `ラン ${runId} を開く`,
    partOfRun: (leadRunId) => `ラン ${leadRunId} の一部`,
    runStatus: {
      queued: '待機中',
      running: '実行中',
      awaiting_approval: '承認待ち',
      completed: '完了',
      failed: '失敗',
      cancelled: 'キャンセル済み',
    },
    noCeiling: '利用額の上限は設定されていません。',
    truncated: 'この一覧に表示しきれないランがあります。すべてはコンソールで確認できます。',
    updatedAt: (time) => `${time} に更新`,
  },
  channel: {
    channelLabel: 'チャネル',
    messagesLabel: 'メッセージ',
    noMessages: 'まだメッセージはありません。最初のメッセージを書きましょう。',
    presenceLabel: '在席中',
    nobodyHere: '現在だれもいません。',
    composerLabel: 'メッセージ',
    replyLabel: 'スレッドに返信',
    send: '送信',
    sending: '送信中…',
    sendFailed: 'メッセージを送信できませんでした。',
    mentionsLabel: 'メンションする相手',
    mentionLabel: (name) => `${name} さんをメンション`,
    attach: 'ファイルを添付',
    uploading: 'ファイルをアップロードしています…',
    uploadFailed: 'ファイルをアップロードできませんでした。',
    openThread: (replies) =>
      replies === 0 ? '返信' : `スレッドを開く（返信 ${String(replies)} 件）`,
    threadLabel: 'スレッド',
    closeThread: 'スレッドを閉じる',
    connecting: '接続しています…',
    reconnecting: '再接続しています…',
    lost: '接続が切れました。新しいメッセージを見るにはページを再読み込みしてください。',
  },
  pages: {
    treeLabel: 'ページ',
    noPages: 'まだページはありません。',
    newPage: '新しいページ',
    untitled: '無題',
    moveTo: '移動…',
    moveHeading: (title) => `${title}を移動`,
    moveUnder: '移動先',
    topLevel: '最上位',
    move: '移動',
    moveIntoItself: 'ページを自分自身やその下のページの下には移動できません。',
    titleLabel: 'タイトル',
    bodyLabel: 'ページ本文',
    editorHint:
      'ブロックの末尾で Enter を押すと新しいブロックになり、先頭で Backspace を押すと前のブロックとつながり、Alt+↑ / Alt+↓ で並べ替えます。',
    blockTypeLabel: (place) => `ブロック ${String(place)} の種類`,
    blockTextLabel: (place, type) => `ブロック ${String(place)} の本文（${type}）`,
    blockTypes: {
      paragraph: '段落',
      heading1: '見出し 1',
      heading2: '見出し 2',
      heading3: '見出し 3',
      bulleted_item: '箇条書き',
      numbered_item: '番号付きリスト',
      quote: '引用',
      code: 'コード',
      divider: '区切り線',
    },
    addBlock: 'ブロックを追加',
    removeBlock: (place) => `ブロック ${String(place)} を削除`,
    nestedItems: (count) => `入れ子の項目 ${String(count)} 件`,
    saved: '保存しました。',
    restored: 'このリビジョンを最新として復元しました。',
    conflictHeading: 'このページは開いた後に変更されました。',
    conflictBody:
      '最新版を読み込んで自分の変更を破棄するか、自分の変更を残して上書き保存してください。',
    agentChangedBody:
      '編集中にエージェントがこのページを変更しました。最新版を読み込むか、自分の変更を残して上書き保存してください。',
    loadLatest: '最新版を読み込む',
    keepMine: '自分の変更を残す',
    showRevisions: 'リビジョンを表示',
    hideRevisions: 'リビジョンを隠す',
    revisionsHeading: 'リビジョン',
    noRevisions: 'まだリビジョンはありません。',
    savedBy: (name) => `${name}が保存`,
    person: (principalId) => `メンバー ${principalId.slice(0, 8)}`,
    agentBadge: 'エージェント',
    anAgent: 'エージェント',
    openRunLabel: (runId) => `ラン ${runId} を開く`,
    preview: 'プレビュー',
    current: '現在',
    restore: '復元',
    restoreLabel: (time) => `${time} のリビジョンを復元`,
    actionsLabel: 'エージェントの操作',
    rewriteWith: (agent) => `${agent}で書き換え`,
    summarizeIntoNewPage: '新しいページに要約',
    problems: {
      page_conflict: 'このページは開いた後に変更されました。',
      page_cycle: 'ページを自分自身やその下のページの下には移動できません。',
      page_space_mismatch: 'ページは同じスペースの中でのみ移動できます。',
      page_has_children:
        'このページの下にページがあります。先にそれらを移動または削除してください。',
      revision_not_found: 'このリビジョンはもう存在しません。',
    },
  },
};

const STRINGS: Readonly<Record<AppLocale, AppStrings>> = { en: EN, ja: JA };

/** The resource parts' strings in `locale`. */
export function appStrings(locale: AppLocale): AppStrings {
  return STRINGS[locale];
}

/** The person-facing sentence for a problem code; a code with no sentence of its own reads `other`. */
export function problemMessage(strings: AppStrings, code: string): string {
  switch (code) {
    case 'session_busy':
    case 'agent_not_offered':
    case 'stream_lost':
      return strings.agentPanel.problems[code];
    case 'recipe_run_not_found':
    case 'recipe_step_not_awaiting_approval':
    case 'approval_already_decided':
    case 'approval_expired':
    case 'recipes_unavailable':
      return strings.recipes.problems[code];
    case 'page_conflict':
    case 'page_cycle':
    case 'page_space_mismatch':
    case 'page_has_children':
    case 'revision_not_found':
      return strings.pages.problems[code];
    case 'unauthenticated':
    case 'forbidden':
    case 'resource_not_found':
    case 'transport_failed':
      return strings.problems[code];
    default:
      return strings.problems.other;
  }
}
