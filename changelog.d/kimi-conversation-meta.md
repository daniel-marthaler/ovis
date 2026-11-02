### Fixed
- Kimi Code chat hides meta traffic again: the CLI stores every message with an `origin`, and
  injections (AGENTS.md, system reminders), task notifications and cron firings are not the
  user's input, so they no longer render as chat bubbles.
