---
changelog: platform
section: Added
---

- The console hides the sidebar entries of features the workspace has switched off or the deployment does not install (ADR-0160 D8). A deep link to a switched-off feature's page says it is switched off, that nothing was deleted, and that a workspace Owner can switch it on in Settings → Features. A workspace with nothing switched off shows the console exactly as before.
- Settings has a **Features** card with one row per feature: its switch, what it needs and what needs it. An Owner switches a feature off after a confirmation that names the navigation entries that disappear and says the data is kept, and switches it back on at once. A switch the server would refuse is disabled with the reason, and other roles see the card read-only. The card, its confirmation and the switched-off page are in English and Japanese.
