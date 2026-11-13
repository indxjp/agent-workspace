---
changelog: platform
section: Added
---

- The run view lists the files a run wrote to its `outputs/` folder once the run ends, each with
  its size and a **Download** button, and links to the folder in Files. Before, those files were
  only in the SDK (`runs.outputs`) or found by browsing Files to `runs/<runId>/outputs/` (UX-14 in
  #2086). A run that wrote nothing shows nothing, and so does a Viewer, who may not read Files.
