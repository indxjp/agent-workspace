import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'assistant',
  title: 'Assistant',
  theme: {
    colour: '#2f5fd0',
  },
  parts: {
    greeting: 'Hi! How can I help you today?',
    suggestedPrompts: [
      'I have a question about my account',
      'Something is not working',
      'How do I get started?',
    ],
    feedback: true,
  },
});
