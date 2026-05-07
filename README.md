# Codex Operator for Local Automation

Small Deno CLI for creating Codex app-server sessions.

`cola` is short for **Codex Operator for Local Automation**.

It starts or connects to `codex app-server`, creates a Codex thread, and sends the first user
message. If no message is provided on the command line, `cola create` opens the editor configured by
`$VISUAL` or `$EDITOR`.

For task-focused CLI usage docs, start with [docs/README.md](docs/README.md).

## Quick Start

Install the CLI:

```sh
deno install --global --config deno.json --allow-run=codex,ps,git,"$EDITOR" --allow-read --allow-write --allow-env --allow-net=127.0.0.1,localhost --name cola ./src/main.ts
```

Open your editor, then create a session and send the saved text as the first message:

```sh
cola create
```

The install command permits the editor executable from `$VISUAL` or `$EDITOR`. If your editor
command includes arguments, such as `code --wait`, only the executable name is added to
`--allow-run`.

Create a session with an inline first message:

```sh
cola create "Run the tests and reposrt failure"
```

Print JSON for scripts:

```sh
cola create --json
```

## Docker Command Test

Build and run the containerized `cola` command test:

```sh
docker build -t cola-command-test .
docker run --rm cola-command-test
```

The container installs the current `src/main.ts` as `cola`, then checks version, help, config, and
alias commands in an isolated config directory.

## Shell Completion

Generate shell completions with `cola completions` after installing the CLI.

For bash, add this to `~/.bashrc`:

```sh
source <(cola completions bash)
```

For zsh, add this to `~/.zshrc`:

```sh
source <(cola completions zsh)
```

For fish, add this to `~/.config/fish/config.fish`:

```fish
cola completions fish | source
```

## Common Options

Choose the workspace or model:

```sh
cola create --cwd "$PWD" --model gpt-5.4
```

Connect to an app-server that is already listening on WebSocket or a Unix socket:

```sh
codex app-server --listen ws://127.0.0.1:9234
cola create --connect ws://127.0.0.1:9234 "Run tests"

codex app-server --listen unix://
cola create --connect unix:// "Run tests"
```

Use a non-default Codex executable:

```sh
cola create --codex-command /path/to/codex
```

## Config and Worktrees

`cola` stores configuration in the XDG config directory: `$XDG_CONFIG_HOME/cola/config.json`, or
`~/.config/cola/config.json` when `XDG_CONFIG_HOME` is unset.

Register a local repository by name:

```sh
cola repo register cola /path/to/repo --branch main
```

Inspect and edit config values:

```sh
cola repo list
cola config get repos.cola.path
cola config set repos.cola.branch trunk
```

Register a reusable description prefix:

```sh
cola alias add fix "Fix: "
cola create fix "handle empty config"
```

The first positional message token is expanded when it matches a registered alias, so the session
above receives `Fix: handle empty config`. Worktrees use the same message expansion. Without an
explicit repo name, `worktree` creates the worktree from the current git repository:

```sh
cola worktree fix "handle empty config"
cola worktree cola fix "handle empty config"
cola create --worktree cola fix "handle empty config"
```

Create a new git worktree from a registered repository and start a Codex session in it:

```sh
cola worktree cola "implement config-backed worktrees"
```

The worktree command follows the Codex App layout and creates a detached worktree under
`$CODEX_HOME/worktrees/<id>/<repo-name>`, or `~/.codex/worktrees/<id>/<repo-name>` when `CODEX_HOME`
is not set. Use `--branch` to override the base branch for one run:

```sh
cola worktree cola "test migration" --branch develop
```

`create` can also prepare the worktree before creating the Codex session:

```sh
cola create --worktree cola "implement config-backed worktrees"
```

## How It Works

When `--connect` is omitted, `cola` looks for a running process like:

```sh
codex app-server --listen ws://127.0.0.1:9234
codex app-server --listen unix://
```

If it finds a reachable local WebSocket or Unix-socket endpoint, it reuses it. Otherwise it starts:

```sh
codex app-server
```

over stdio.

When `--connect` is set, `--codex-command` is ignored because the existing server already chose its
executable.

The command prints the created thread/session id and exits. The app-server writes rollout files
under Codex's default state directory, or under `$CODEX_HOME/sessions` when `CODEX_HOME` is set in
the environment.
