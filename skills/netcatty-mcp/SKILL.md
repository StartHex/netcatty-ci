---
name: netcatty-mcp
description: Use when the user asks to inspect or operate Netcatty terminals, remote hosts, SSH or other live sessions, SFTP files, vault data, snippets, scripts, or port forwards through Netcatty MCP.
metadata:
  managed-by: netcatty
---

# Netcatty MCP

Use the Netcatty MCP tools whenever the task targets Netcatty or a remote session managed by Netcatty.

- For terminal work, call `get_environment` first. Select the current target by its label or hostname and pass its `sessionId` to terminal tools.
- Never use the local shell for commands intended for a Netcatty session.
- If a required specialized tool is not visible, call `load_netcatty_tools` with `attachments`, `sftp_advanced`, `vault_hosts`, `vault_notes`, `snippets`, `scripts`, or `portforward`. Use `all` only when several categories are needed.
- If no live session matches, use `vault_hosts_list` and `host_open`. A newly opened tab lands in your own bound workspace by default (workspace chat → that workspace; terminal chat → that terminal's workspace); only pass `workspaceId` when the user asks for a different target. Close only sessions opened for the current task when they are no longer needed.
- Use `terminal_execute` for short commands. Use `terminal_start`, `terminal_poll`, and `terminal_stop` for long-running or streaming commands.
- Vault notes live in two areas, `daily` and `organized`. To organize daily notes, load `vault_notes`, list with `area=daily` and `organized=false` (plus a time range), read each note with `vault_notes_get`, then write one `vault_notes_create` with `area=organized` and `organizedFrom` set to the source ids. The sources keep their text and are marked organized. `NOTES_ACCESS_DISABLED` means the user has not enabled notes for MCP clients in Settings; ask them instead of working around it. `[hidden]` in note text is a masked secret: never write it back into a note.
- Treat Netcatty permission denials and tool errors as authoritative. Do not bypass them with local commands or alternate connection tools.
