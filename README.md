# cxs

Small Deno CLI for creating Codex app-server sessions.

It starts or connects to `codex app-server`, creates a Codex thread, and optionally sends the first
user message.

## Quick Start

Install the CLI:

```sh
deno install --global --allow-run=codex,ps --allow-read --allow-env --allow-net=127.0.0.1,localhost --name cxs ./src/main.ts
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
