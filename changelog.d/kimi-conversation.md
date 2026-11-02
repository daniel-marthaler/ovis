### Added
- Kimi Code panes get a chat: the conversation is read from the CLI's own wire log
  (`~/.kimi-code/sessions/wd_<dir>_<hash>/session_<id>/agents/main/wire.jsonl`), with user prompts,
  answers, thinking and tool calls as turns, instead of falling back to the terminal scrollback.
