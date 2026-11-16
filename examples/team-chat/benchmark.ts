// The apps benchmark's declaration for examples/team-chat (tests/apps/benchmark.ts reads it). It
// imports nothing, so the app reaches nothing outside itself; tests/apps/registry.ts checks it.
export default {
  id: 'team-chat',
  order: 1,
  title: 'Team chat',
  reference: true,
  budget: 150,
  // The generated files this app made its own code; Handwritten counts each in full (a test not).
  takenOver: [
    'app/channels/[id]/page.tsx',
    'recipes/on-mention.ts',
    'resources/message.ts',
    'tests/recipes/on-mention.test.ts',
  ],
  cells: {
    journeys: {
      verdict: 'ok',
      evidence: 'lane',
      file: 'examples/team-chat/e2e/team-chat.e2e.mjs',
      ref: 'signature: a mention produces an agent reply in the thread',
      note: "in en and ja, under aw dev with the scripted model: a member opens a channel and posts (J3), and a mention of @helper runs the helper, whose reply lands in the mention's thread in a second browser without a reload",
    },
    agentOnData: {
      verdict: 'ok',
      evidence: 'contract',
      file: 'examples/team-chat/tests/agent-on-data.test.ts',
      ref: 'the helper reads a channel as the person and is refused deleting it',
      note: 'the helper lists channels through the app connector as the member, and has no delete tool, so a delete is refused by unknown_tool',
    },
    selfHost: {
      verdict: 'ok',
      evidence: 'lane',
      file: 'tests/apps/lane.mjs',
      ref: 'self-host',
      note: 'aw deploy renders the app into Compose and Helm with its image and app_team_chat, npm run image builds that image, and the platform boots it healthy on its own database role',
    },
  },
} as const;
