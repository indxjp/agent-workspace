/**
 * The safety claims the /platform page makes, worded as the spec words them (§02 and §04, "Safe to
 * use"): each is `holds` today, with the evidence files that prove it (repository paths), or `planned` for a phase and
 * is shown with that marker until its test exists. A claim that is not proven is never shown as
 * holding. Pure, so `pnpm test` can check which claim is which.
 */
export type ClaimId =
  'person' | 'approval' | 'network' | 'sampleData' | 'runRecorded' | 'noInternet';

export type ClaimStatus =
  | { readonly kind: 'holds'; readonly evidence: readonly string[] }
  | { readonly kind: 'planned'; readonly phase: string };

export interface Claim {
  readonly id: ClaimId;
  readonly status: ClaimStatus;
  readonly text: { readonly ja: string; readonly en: string };
}

export const CLAIMS: readonly Claim[] = [
  {
    id: 'person',
    status: {
      kind: 'holds',
      evidence: [
        'examples/wiki/tests/agent-on-data.test.ts',
        'apps/web/server/runs/attachments.test.ts',
      ],
    },
    text: {
      ja: 'エージェントは頼んだ人の権限を超えません。権限のない操作は拒否されます。',
      en: 'An agent never exceeds the access of the person who asked. What that person may not do is refused.',
    },
  },
  {
    id: 'approval',
    status: { kind: 'holds', evidence: ['apps/web/server/sdk-conformance.runs-approval.test.ts'] },
    text: {
      ja: '書き込みは、人の承認を待たせることができます。',
      en: 'Writes can wait for a person’s approval.',
    },
  },
  {
    id: 'network',
    status: { kind: 'holds', evidence: ['packages/runtime/src/docker.test.ts'] },
    text: {
      ja: '実行環境のネットワークは既定で遮断され、モデルのゲートウェイ以外へは外向きの通信をしません。',
      en: 'A sandbox’s network policy is none by default: outbound traffic is blocked except to the model gateway.',
    },
  },
  {
    id: 'sampleData',
    status: { kind: 'holds', evidence: ['apps/web/server/demo/provision/fake-sends.test.ts'] },
    text: {
      ja: 'デモはサンプルデータだけに触れます。送信や書き込みのツールは偽物で、外には何も送られません。',
      en: 'Demos touch sample data only. The send and write tools are fakes: nothing is really sent or written outside.',
    },
  },
  {
    id: 'runRecorded',
    status: { kind: 'holds', evidence: ['apps/web/server/demo/proof/run-recorded.test.ts'] },
    text: {
      ja: 'デモのすべての実行は、頼んだ人・エージェント・日時・結果とともに実行履歴に残ります。',
      en: 'Every demo run is recorded in the run history with the person who asked, the agent, the time and the outcome.',
    },
  },
  {
    id: 'noInternet',
    status: { kind: 'holds', evidence: ['apps/web/server/demo/proof/no-internet.test.ts'] },
    text: {
      ja: 'デモのサンドボックスはインターネットに出られません。',
      en: 'Demo sandboxes have no internet.',
    },
  },
];

/** The marker a planned claim carries, in the spec's words. */
export function plannedMarker(phase: string, lang: 'ja' | 'en'): string {
  return lang === 'ja' ? `計画 · ${phase}` : `Planned · ${phase}`;
}
