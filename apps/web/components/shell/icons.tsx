/**
 * The thirteen navigation glyphs, transcribed from the `ICONS` table in `ui/assets/app.js`.
 *
 * The path data is copied verbatim; the wrapper reproduces that file's `icon()` helper exactly —
 * a 16×16 viewBox, no fill, `currentColor` strokes at 1.4, round caps and joins, and
 * `aria-hidden` because every icon in the shell sits beside its own text label.
 *
 * Only the glyphs the sidebar uses are here. The mockup's table also carries `search`, `folder`,
 * `file`, `plus`, `play`, `dots`, `upload`, `download`, `back`, `check`, `shield` and `lock`,
 * which belong to screens no Wave 1 task builds; they are transcribed by the task that needs
 * them rather than carried here unused.
 */
import type { ReactNode } from 'react';

const ICONS = {
  chat: (
    <path d="M13.5 8.6c0 2.5-2.5 4.5-5.5 4.5-.7 0-1.4-.1-2-.3L2.5 13.5l.8-2.6A4.3 4.3 0 0 1 2.5 8.6C2.5 6.1 5 4.1 8 4.1s5.5 2 5.5 4.5" />
  ),
  projects: (
    <>
      <path d="M2.5 4.6A1.1 1.1 0 0 1 3.6 3.5h2.6l1.1 1.5h5.1a1.1 1.1 0 0 1 1.1 1.1v5.3a1.1 1.1 0 0 1-1.1 1.1H3.6a1.1 1.1 0 0 1-1.1-1.1z" />
      <path d="M2.5 7.6h11" />
    </>
  ),
  agents: (
    <>
      <rect x="2.5" y="4.5" width="11" height="8" rx="2" />
      <path d="M8 2.5v2M5.5 8h.01M10.5 8h.01" />
    </>
  ),
  files: (
    <path d="M2.5 4.2A1.2 1.2 0 0 1 3.7 3h2.4l1.2 1.6h4.9A1.2 1.2 0 0 1 13.4 5.8v6A1.2 1.2 0 0 1 12.2 13H3.7a1.2 1.2 0 0 1-1.2-1.2z" />
  ),
  skills: <path d="M8 2.2 9.7 6l4 .4-3 2.7.9 3.9L8 11l-3.6 2 .9-3.9-3-2.7 4-.4z" />,
  connectors: (
    <path d="M6.2 9.8 4.6 11.4a2.3 2.3 0 0 1-3.2-3.2L3 6.6M9.8 6.2l1.6-1.6a2.3 2.3 0 0 1 3.2 3.2L13 9.4M6 10l4-4" />
  ),
  runs: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2 1.2" />
    </>
  ),
  models: (
    <>
      <path d="M8 2.5 13.5 5.6v4.8L8 13.5 2.5 10.4V5.6z" />
      <path d="M8 8 13.5 5.6M8 8v5.5M8 8 2.5 5.6" />
    </>
  ),
  users: (
    <>
      <circle cx="6" cy="6" r="2.4" />
      <path d="M1.8 13c.4-2.3 2.2-3.6 4.2-3.6S9.8 10.7 10.2 13" />
      <path d="M10.6 4.2a2.2 2.2 0 0 1 0 4.1M11.5 13c-.1-1.2-.4-2.2-1-3" />
    </>
  ),
  keys: (
    <>
      <circle cx="5.4" cy="8" r="2.6" />
      <path d="M8 8h6M12 8v2.4M10.2 8v1.8" />
    </>
  ),
  runtimes: (
    <>
      <rect x="2" y="3" width="12" height="4.2" rx="1" />
      <rect x="2" y="8.8" width="12" height="4.2" rx="1" />
      <path d="M4.4 5.1h.01M4.4 10.9h.01" />
    </>
  ),
  share: (
    <>
      <circle cx="12" cy="4" r="1.8" />
      <circle cx="4" cy="8" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <path d="m5.6 7.1 4.8-2.2M5.6 8.9l4.8 2.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" />
    </>
  ),
} as const satisfies Record<string, ReactNode>;

/**
 * The names `icons.tsx` can draw. `navigation.ts` types its `icon` field as this, so a nav entry
 * naming a glyph that is not in the table above fails `tsc` rather than rendering an empty box.
 */
export type IconName = keyof typeof ICONS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {ICONS[name]}
    </svg>
  );
}
