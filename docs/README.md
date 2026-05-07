# Use the cola CLI

Use `cola` to create Codex app-server sessions from a terminal.

## Requirements

- Deno is installed.
- Codex CLI is installed as `codex`, or you know its executable path.
- You are in this repository, or `cola` is already installed globally.

## Procedure

1. Install `cola` if the command is not available.
2. Run `cola --help` to list available commands.
3. Use `cola create` to start a Codex session in the current directory.
4. Use `cola repo`, `cola alias`, and `cola config` to set reusable defaults.
5. Use `cola worktree` when you want a new git worktree and a Codex session in it.

## Expectations

- `cola --help` prints the command list.
- `cola create "message"` prints a Codex session id.
- Commands that create a first turn print a turn id.
- Commands that fail print an error and, when available, a hint.

## Documents

- [Install cola](install.md)
- [Create a Codex session](create-session.md)
- [Use a Codex app-server socket](connect-app-server.md)
- [Manage repositories and worktrees](worktrees.md)
- [Manage config values](config.md)
- [Use aliases](aliases.md)
- [Install shell completions](completions.md)
- [Run the Docker command test](docker-command-test.md)
