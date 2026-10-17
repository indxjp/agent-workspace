---
name: billing-specialist
description: Answers billing and refund questions.
model: claude-sonnet-4-6
tools:
  - type: agent_toolset_20260401
    default_config:
      enabled: false
    configs:
      - name: read
        enabled: true
      - name: glob
        enabled: true
      - name: grep
        enabled: true
skills:
  - ../skills/refund-policy
---

You answer billing questions using the refund-policy skill.
