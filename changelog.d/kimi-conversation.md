### Added
- Kimi Code panes get a chat: the conversation is read from the CLI's own wire log
  (`~/.kimi-code/sessions/wd_<dir>_<hash>/session_<id>/agents/main/wire.jsonl`), with user prompts,
  answers, thinking and tool calls as turns, instead of falling back to the terminal scrollback.
  The pane's session is proven by the log file its process holds open or by the session lock the
  CLI writes for its pid (`~/.kimi-code/locks/sessions/`); without that proof the pane keeps its
  terminal, never another session of the folder. herdr's `kimi-code` label maps to `kimi`.
