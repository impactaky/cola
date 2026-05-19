# Use the Cola Server Socket

Run a host-side `cola` server when a container needs guarded access to registered repositories and
worktree creation without mounting the raw Codex app-server socket.

## Requirements

- `cola` is installed on the host.
- The host `cola` config contains the repositories the server should allow.
- The container can access the Cola server Unix socket path.

## Procedure

1. Register allowed repositories on the host:

   ```sh
   cola repo register resnet8 /path/to/resnet8 --branch main
   ```

2. Start the host-side server:

   ```sh
   cola server
   ```

   By default, the server listens at:

   ```sh
   unix:///run/user/$UID/cola/server.sock
   ```

3. Or choose a socket path that is convenient to mount into a container:

   ```sh
   cola server --listen unix:///run/cola/server.sock
   ```

4. In the container, point `cola` at that socket:

   ```sh
   export COLA_SERVER_URL=unix:///run/cola/server.sock
   cola repo list
   cola worktree resnet8 "task"
   ```

## Expectations

- `cola repo list` is handled by the server and prints the host server's registered repo allowlist.
- `cola worktree <repo> "task"` is handled by the server when `COLA_SERVER_URL` is set or the
  default server socket exists.
- The server accepts only narrow `repo/list` and `worktree/create-session` requests.
- Worktree requests are restricted to repository names registered in the server host config.
- Requests for unknown repository names fail server-side before any worktree or Codex session is
  created.
- Server-handled requests append JSONL audit records to `$XDG_CONFIG_HOME/cola/server-audit.jsonl`,
  or `~/.config/cola/server-audit.jsonl` when `XDG_CONFIG_HOME` is unset. Use `--audit-log <path>`
  to override this.
- If `COLA_SERVER_URL` is set, or the default server socket exists, but the server is unavailable,
  `cola` fails instead of falling back to local mode.
- Set `COLA_ALLOW_LOCAL_FALLBACK=1` only when local mode is intentionally allowed:

  ```sh
  COLA_ALLOW_LOCAL_FALLBACK=1 cola repo list
  ```
