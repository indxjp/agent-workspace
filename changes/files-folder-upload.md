---
changelog: platform
section: Added
---

- The Files screen uploads a whole folder: pick one with "Upload a folder and everything in it", or
  drop one on the list. Each file lands at its path inside the folder under the folder on screen,
  the server adds the folders on the way, and an empty subfolder of a dropped folder is created too.
  Each file is said to be uploaded or not and why, as for several files. One upload takes at most
  1,000 files; a larger one is refused before anything is sent. A dropped folder used to be skipped
  with "Upload the files inside it instead" (#2086).
