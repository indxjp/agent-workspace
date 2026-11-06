---
changelog: platform
section: Fixed
---

- Connect storage: a name the server would refuse (capitals, spaces, underscores, a leading digit,
  or an ID-shaped name) is now caught before saving, with what a name may contain, instead of "The
  storage connection could not be saved." (UX-08 in #2086).
