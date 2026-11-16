import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Agent Workspace',
  description: 'Self-hosted control plane for the Claude Agent SDK.',
};

/**
 * The page is English, the language every screen starts in. A part translated for a Japanese
 * reader says so on its own element (`lang={locale}`: the shell, the agent screens, the run's files,
 * Files search), so a screen reader reads Japanese parts as Japanese and the screens still in
 * English as English (UX-15 in #2086).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
