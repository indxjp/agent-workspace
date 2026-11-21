// The apps benchmark's declaration for examples/store (tests/apps/benchmark.ts reads it). It imports
// nothing, so the app reaches nothing outside itself; tests/apps/registry.ts checks it. The store is
// registered so "this site was built with the SDK too" is a measured fact, but it is not one of the
// four reference apps the programme's criterion counts (reference: false).
export default {
  id: 'store',
  order: 5,
  title: 'Agent Store',
  reference: false,
  // 5310 since 2026-11-21 (Owner decision, was 5200): the room for the landing pages' search and
  // social metadata, social cards and screenshots (use-cases plan §6.3, unit L3).
  budget: 5310,
  // The generated files this app made its own code; Handwritten counts each in full (a test not).
  takenOver: [
    'app/chat/page.tsx',
    'app/contact/page.tsx',
    'app/files/page.tsx',
    'app/layout.tsx',
    'app/page.tsx',
    'app/platform/page.tsx',
    'app/privacy/page.tsx',
    'app/runs/[id]/page.tsx',
    'app/runs/page.tsx',
    'app/sign-in/page.tsx',
    'app/theme.ts',
    'package.json',
  ],
  cells: {
    journeys: {
      verdict: 'ok',
      evidence: 'lane',
      file: 'examples/store/e2e/store.e2e.mjs',
      ref: 'J1: a visitor finds an agent on the shelf and reaches the sign-up gate',
      note: "in en and ja, a visitor opens an agent from its area's shelf, reaches the sign-up gate of its Try it section, is refused without consent, and is told it is not available yet once the platform has no sender; the filters, the Customize preview, Under the hood, a live and a coming-soon landing page, /platform, /privacy, /contact, the language switch and a role-and-name check of every screen run beside it",
    },
    agentOnData: {
      verdict: 'gap',
      evidence: 'contract',
      file: 'examples/store/tests/agent-on-data.test.ts',
      ref: 'the store keeps no data of its own, so no agent acts on any',
      note: 'the store keeps no data of its own and its demos run on the platform, so it has no resource for an agent to act on as a person; the test keeps that true',
    },
    selfHost: {
      verdict: 'ok',
      evidence: 'lane',
      file: 'tests/apps/lane.mjs',
      ref: 'self-host',
      note: 'aw deploy renders the app into Compose and Helm with its image and app_store, npm run image builds that image, and the platform boots it healthy on its own database role',
    },
  },
} as const;
