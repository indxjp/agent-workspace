---
changelog: platform
section: Changed
---

- On the Runtimes screen, a registered runtime's disabled reason ("No runtime connection is
  configured.", "The runtime image is not reachable.") is in Japanese for a Japanese reader. The
  server still sends the English reason; the screen words it from the entry's connection and image
  flags, and shows any other reason as it came. English is unchanged (UX-15 in #2086).
