# Use a Codex app-server Socket

Connect `cola` to a running Codex app-server instead of spawning one over stdio.

## Requirements

- Codex CLI is installed.
- A Codex app-server is listening on a local `ws://` or `unix://` URL.
- The socket URL is reachable from the terminal running `cola`.

## Procedure

1. Start a Codex app-server in one terminal:

   ```sh
   codex app-server --listen ws://127.0.0.1:9234
   ```

2. Or start it on a Unix socket:

   ```sh
   codex app-server --listen unix://
   ```

3. Create a session through that server in another terminal:

   ```sh
   cola create --connect ws://127.0.0.1:9234 "Run tests"
   cola create --connect unix:// "Run tests"
   ```

4. Omit `--connect` when you want `cola` to search running processes for a reachable local
   app-server:

   ```sh
   cola create "Use an existing server if one is reachable"
   ```

## Expectations

- With `--connect`, output includes `Connected app-server: ws://127.0.0.1:9234`.
- Without `--connect`, `cola` reuses a reachable process that includes
  `app-server --listen ws://...` or `app-server --listen unix://...`.
- If no reachable socket server is found, `cola` starts `codex app-server` over stdio.
- `--connect` must start with `ws://` or `unix://`.
