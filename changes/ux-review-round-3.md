---
changelog: platform
section: Fixed
---

- Emptying a schedule's Time zone no longer replaces the Schedules tab with an error page; the form
  says "Enter a time zone, for example Asia/Tokyo." and waits (UX-18 in #2086).
- A screen reader reads the console's English screens in English again for a Japanese browser: the
  page stays `lang="en"`, and each translated part (the sidebar, the top bar, the skip link, the
  runtime band, a run's files, Files search and the Modified column) says `lang="ja"` itself
  (UX-15 in #2086).
- When an upload batch ends after the person opened another folder, the folder on screen is the one
  refreshed, not the folder the batch started in (UX-16 in #2086).
- Closing a schedule's Change time form (Cancel, Escape or Save) or the delete question (Keep or
  Escape) puts the keyboard focus back on the button that opened it.
