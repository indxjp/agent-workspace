/**
 * The Runtimes screen's own words in the reader's language (UX-15 in #2086), in the shape of
 * `../resources/admin-messages.ts`.
 *
 * English is not repeated here. The picker's labels, descriptions and disabled reasons and the
 * switch comparison are transcribed from `docs/spec.md` §14.8–14.9 and `ui/runtimes.html` into
 * `./model.ts`, and `./model.test.ts` holds them to those documents character for character; an
 * English reader is shown exactly those. Japanese is a translation of them, one entry per driver,
 * so a driver added to the contract fails `typecheck` here until it is worded.
 *
 * What the server sends — a registered runtime's own disabled reason or refusal, the Test Runtime
 * transcript, and a refusal's message — is shown as it comes.
 */
import type { RuntimeDriver } from '../../contracts/runtimes';
import type { VersionsLocale } from '../agents/versions-messages';

import { RUNTIME_OPTIONS, SWITCH_COMPARISON, type RuntimeOption } from './model';

/** One picker row's words. */
type RuntimeOptionWords = Readonly<{
  label: string;
  description: string;
  side?: string;
  defaultReason?: string;
}>;

export interface RuntimesStrings {
  readonly option: Readonly<Record<RuntimeDriver, RuntimeOptionWords>>;
  readonly switchComparison: Readonly<{
    heading: string;
    warnings: readonly string[];
    blockers: readonly string[];
  }>;
  readonly title: string;
  readonly intro: string;
  readonly runtime: string;
  readonly selectableRule: string;
  readonly managedSandbox: string;
  readonly notRegistered: string;
  readonly unverified: string;
  readonly refusesEveryRun: string;
  readonly noIsolation: string;
  readonly recommended: string;
  readonly testing: string;
  readonly testRuntime: string;
  readonly saving: string;
  readonly save: string;
  readonly readyToUse: (name: string) => string;
  /** "A driver that is not usable here is shown <b>disabled with the reason</b>, never hidden. …" */
  readonly disabledNoteBefore: string;
  readonly disabledNoteBold: string;
  readonly disabledNoteAfter: string;
  readonly switchComparisonHeading: string;
  readonly notAllowed: string;
}

/** English options are the spec's, as `./model.ts` transcribes them. */
const ENGLISH_OPTIONS = Object.fromEntries(
  RUNTIME_OPTIONS.map((option: RuntimeOption) => [
    option.id,
    {
      label: option.label,
      description: option.description,
      ...(option.side === undefined ? {} : { side: option.side }),
      ...(option.defaultReason === undefined ? {} : { defaultReason: option.defaultReason }),
    },
  ]),
) as Record<RuntimeDriver, RuntimeOptionWords>;

const EN: RuntimesStrings = {
  option: ENGLISH_OPTIONS,
  switchComparison: SWITCH_COMPARISON,
  title: 'Runtimes',
  intro: 'Select where agent sessions run and verify the sandbox before use.',
  runtime: 'Runtime',
  selectableRule:
    'A driver is selectable only when a connection exists, the image is reachable, and a test has passed.',
  managedSandbox: 'Managed sandbox',
  notRegistered: 'Not configured — this runtime is not registered.',
  unverified: 'Unverified',
  refusesEveryRun: 'Refuses every run',
  noIsolation: 'No isolation',
  recommended: 'Recommended',
  testing: 'Testing…',
  testRuntime: 'Test Runtime',
  saving: 'Saving…',
  save: 'Save',
  readyToUse: (name) => `${name} is ready to use.`,
  disabledNoteBefore: 'A driver that is not usable here is shown ',
  disabledNoteBold: 'disabled with the reason',
  disabledNoteAfter:
    ', never hidden. The control plane registers and selects runtimes — it does not build images, create session pools or provision clusters.',
  switchComparisonHeading: 'Runtime switch comparison',
  notAllowed: 'Only workspace Owners and Admins can view runtimes.',
};

const NOT_SET_TO_THIS_DRIVER =
  '未設定 — ランナーマネージャーがこのドライバーに設定されていません。';

const JA: RuntimesStrings = {
  option: {
    local: {
      label: 'このマシン',
      description:
        '開発専用です。エージェントはランナーの子プロセスとして、同じユーザーで実行されます。',
      side: '分離なし',
    },
    'sandbox-runtime': {
      label: 'サンドボックス化したプロセス',
      description:
        'Linux では bubblewrap、macOS では Seatbelt。コンテナーなしで、ファイルシステムとネットワークを許可リストで制限します。',
      side: 'npx、Docker 不要',
    },
    docker: {
      label: 'Docker',
      description:
        'セッションごとに 1 コンテナー。ケーパビリティを削除し、ルートは読み取り専用、外部ネットワークはゲートウェイのみに制限します。',
      side: 'セルフホストにおすすめ',
    },
    kubernetes: {
      label: 'Kubernetes',
      description:
        'ランタイムごとに 1 Pod · 名前空間 agent-sandboxes · 既定で拒否する NetworkPolicy · 任意で gVisor RuntimeClass',
      side: '移植可能なエンタープライズ向け',
    },
    'aca-sessions': {
      label: 'Azure Container Apps 動的セッション',
      description:
        'プール登録済み · セッションごとに Hyper-V · ネットワークポリシーはプール作成時に固定され、レジストリが報告します',
    },
    'aws-agentcore': {
      label: 'Amazon Bedrock AgentCore Runtime',
      description: 'マネージドな Firecracker microVM ランタイムです。',
      defaultReason: 'このアカウントの ECR にイメージが公開されていません（arm64 が必要）。',
    },
    'aws-ecs': {
      label: 'Amazon ECS on Fargate',
      description: 'VM で分離された Fargate タスクです。',
      defaultReason: '未設定 — タスク定義が登録されていません。',
    },
    'cloud-run-sandbox': {
      label: 'Google Cloud Run サンドボックス',
      description: 'マネージドな Cloud Run サンドボックスです。',
      defaultReason: '未設定 — --sandbox-launcher 付きでデプロイされたランナーがありません。',
    },
    'cloud-run-service': {
      label: 'Google Cloud Run（セッションごとのサービス）',
      description:
        'セッションごとに非公開の Cloud Run v2 サービスを 1 つ、ランナーマネージャーがデプロイします。Google Cloud Run サンドボックスがまだ使えないため、その代わりに使います。',
      defaultReason: NOT_SET_TO_THIS_DRIVER,
    },
    'gke-agent-sandbox': {
      label: 'GKE Agent Sandbox',
      description: 'マネージドな GKE Agent Sandbox ランタイムです。',
      defaultReason: '未設定 — クラスターが Sandbox の CRD を公開していません。',
    },
    'vercel-sandbox': {
      label: 'Vercel Sandbox',
      description:
        'セッションごとに 1 つの Firecracker microVM を、Vercel Sandbox API で作成します。',
      defaultReason: NOT_SET_TO_THIS_DRIVER,
    },
    'cloudflare-sandbox': {
      label: 'Cloudflare Sandbox',
      description:
        'ブリッジ Worker の背後で、セッションごとに 1 つの Cloudflare コンテナーを使います。外部への通信を遮断できると確認されるまではすべてのネットワーク設定を拒否するため、まだサンドボックスを作成できません。実環境での検証はまだです。',
      defaultReason: NOT_SET_TO_THIS_DRIVER,
    },
    external: {
      label: '外部プロバイダー',
      description: 'E2B、Daytona、Modal、Cloudflare Sandboxes。登録されているものはありません。',
    },
  },
  switchComparison: {
    heading: 'ランタイムの変更: Docker → Azure Container Apps 動的セッション',
    warnings: [
      '⚠ このランタイムはドメインの許可リストに対応していません。',
      '「制限付き」は、外部通信をすべて許可するか、すべて禁止するかのどちらかになります。',
    ],
    blockers: [
      '✕ このエージェントはローカルコマンドのコネクタ（Filesystem MCP）を使っています。',
      'このランタイムには、パッケージをダウンロードするための外部ネットワークがありません。',
      'コネクタをランタイムのイメージに含めるか、リモート URL に切り替えてください。',
    ],
  },
  title: 'ランタイム',
  intro: 'エージェントのセッションを実行する場所を選び、使う前にサンドボックスを確認します。',
  runtime: 'ランタイムを選択',
  selectableRule:
    'ドライバーを選べるのは、接続があり、イメージに到達でき、テストに合格したときだけです。',
  managedSandbox: 'マネージドサンドボックス',
  notRegistered: '未設定 — このランタイムは登録されていません。',
  unverified: '未検証',
  refusesEveryRun: 'すべての実行を拒否',
  noIsolation: '分離なし',
  recommended: 'おすすめ',
  testing: 'テスト中…',
  testRuntime: 'ランタイムをテスト',
  saving: '保存中…',
  save: '保存',
  readyToUse: (name) => `${name} を使用できます。`,
  disabledNoteBefore: 'ここで使えないドライバーは隠さず、',
  disabledNoteBold: '理由とともに無効',
  disabledNoteAfter:
    'として表示します。コントロールプレーンはランタイムを登録・選択するだけで、イメージのビルド、セッションプールの作成、クラスターのプロビジョニングは行いません。',
  switchComparisonHeading: 'ランタイム変更の比較',
  notAllowed: 'ランタイムを表示できるのは、ワークスペースのオーナーと管理者だけです。',
};

const STRINGS: Readonly<Record<VersionsLocale, RuntimesStrings>> = { en: EN, ja: JA };

export function runtimesStrings(locale: VersionsLocale): RuntimesStrings {
  return STRINGS[locale];
}
