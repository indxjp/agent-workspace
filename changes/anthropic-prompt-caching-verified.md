---
changelog: platform
section: Changed
---

- Claude models on an Anthropic API connection now declare prompt caching, so the agent form no
  longer warns that caching is unsupported for them. A weekly live check
  (`model-providers-live.yml`) verified that a cached prompt is written once and then read, in plain
  and streamed requests, through the gateway. Claude on Vertex AI and models on an
  Anthropic-compatible connection still declare no prompt caching, since no live run has shown it
  for them.
