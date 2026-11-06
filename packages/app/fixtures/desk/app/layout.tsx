import '@indx-workspace/app/react/styles.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'Desk' };

/** The desk's pages are each themed in their own language by `AppTheme`. */
export default function RootLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
