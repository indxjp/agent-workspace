---
name: support-triage
description: Triages customer support tickets and drafts replies.
model: claude-sonnet-4-6
mcp_servers:
  - type: url
    name: zendesk
    url: https://mcp.example.com/zendesk
tools:
  - type: agent_toolset_20260401
    default_config:
      enabled: false
    configs:
      - name: bash
        enabled: true
      - name: read
        enabled: true
      - name: glob
        enabled: true
      - name: grep
        enabled: true
      - name: web_search
        enabled: true
  - type: mcp_toolset
    mcp_server_name: zendesk
skills:
  - ../skills/refund-policy
multiagent:
  type: multiagent_20261001
  subagents:
    type: enabled
    inline_agents:
      type: disabled
    predefined_agents:
      - type: agent
        id: ./billing-specialist.md
  workflows:
    type: disabled
---

You triage support tickets.

- Look up the order before answering.
- Hand billing questions to billing-specialist.
