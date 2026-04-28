# cxs

Small Deno CLI for creating Codex app-server sessions.

It starts or connects to `codex app-server`, creates a Codex thread, and optionally sends the first
user message.

## Quick Start

Install the CLI:

```sh
deno install --global --allow-run=codex,ps,git --allow-read --allow-write --allow-env --allow-net=127.0.0.1,localhost --name cxs ./src/main.ts
```

Create a session in the current directory:

```sh
cxs create
```

Create a session and immediately start a turn:

```sh
cxs create --message "Run the tests and report failures"
```

Print JSON for scripts:

```sh
cxs create --json
```

## Common Options

Choose the workspace or model:

```sh
cxs create --cwd "$PWD" --model gpt-5.4
```

Connect to an app-server that is already listening on WebSocket:

```sh
codex app-server --listen ws://127.0.0.1:9234
cxs create --connect ws://127.0.0.1:9234 --message "Run tests"
```

Use a non-default Codex executable:

```sh
cxs create --codex-command /path/to/codex
```

## Config and Worktrees

`cxs` stores configuration in `$CXS_CONFIG_DIR/config.json` when `CXS_CONFIG_DIR` is set, otherwise
under `$XDG_CONFIG_HOME/cxs/config.json` or `~/.config/cxs/config.json`.

Register a local repository by name:

```sh
cxs repo register cxs /path/to/repo --branch main
```

Inspect and edit config values:

```sh
cxs repo list
cxs config get repos.cxs.path
cxs config set repos.cxs.branch trunk
```

Create a new git worktree from a registered repository and start a Codex session in it:

```sh
cxs worktree cxs "implement config-backed worktrees"
```

The worktree command follows the Codex App layout and creates a detached worktree under
`$CODEX_HOME/worktrees/<id>/<repo-name>`, or `~/.codex/worktrees/<id>/<repo-name>` when `CODEX_HOME`
is not set. Use `--branch` to override the base branch for one run:

```sh
cxs worktree cxs "test migration" --branch develop
```

`create` can also prepare the worktree before creating the Codex session:

```sh
cxs create --worktree cxs --message "implement config-backed worktrees"
```

## How It Works

When `--connect` is omitted, `cxs` looks for a running process like:

```sh
codex app-server --listen ws://127.0.0.1:9234
```

If it finds a reachable local WebSocket endpoint, it reuses it. Otherwise it starts:

```sh
codex app-server
```

over stdio.

When `--connect` is set, `--codex-command` is ignored because the existing server already chose its
executable.

The command prints the created thread/session id and exits. The app-server writes rollout files
under Codex's default state directory, or under `$CODEX_HOME/sessions` when `CODEX_HOME` is set in
the environment.
