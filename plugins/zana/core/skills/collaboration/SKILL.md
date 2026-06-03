---
name: collaboration
description: Agent collaboration primitives — SendMessage for native Claude Code subagents; zana_send_message / zana_publish_channel / zana_artifact_* / zana_checkpoint_* for daemon-spawned agents that lack Claude Code primitives.
when_to_use: Agent needs to communicate with other agents, share context, or coordinate work. Inside Claude Code, prefer the native SendMessage. Daemon agents (headless / CI / scheduled) use the Zana MCP collaboration tools.
user-invocable: false
---

!`cat ${CLAUDE_PLUGIN_ROOT}/skills/collaboration/GUIDE.md`
