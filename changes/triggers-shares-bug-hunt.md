---
changelog: platform
section: Fixed
---

- A trigger whose run fails to start now logs it when freeing the delivery claim fails too, and a schedule slot whose claim has no run is no longer marked fired.
- A whitespace-only `CRON_SECRET` is read as unset by every cron driver, so the in-process schedulers start instead of neither driver running.
- A passphrase-protected public share link verifies the passphrase off the event loop and refuses further guesses (429 `passphrase_attempts_limited`) after 10 wrong ones a minute per link and 5 per visitor.
