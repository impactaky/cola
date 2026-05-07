# Use a Codex app-server WebSocket

Connect `cola` to a running Codex app-server instead of spawning one over stdio.

## Requirements

- Codex CLI is installed.
- A Codex app-server is listening on a local `ws://` URL.
- The WebSocket URL is reachable from the terminal running `cola`.

## Procedure

1. Start a Codex app-server in one terminal:

   ```sh
   codex app-server --listen ws://127.0.0.1:9234
   ```

2. Create a session through that server in another terminal:

   ```sh
   cola create --connect ws://127.0.0.1:9234 "Run tests"
   ```

3. Omit `--connect` when you want `cola` to search running processes for a reachable local
   app-server:

   ```sh
   cola create "Use an existing server if one is reachable"
   ```

## Expectations

- With `--connect`, output includes `Connected app-server: ws://127.0.0.1:9234`.
- Without `--connect`, `cola` reuses a reachable process that includes
  `app-server --listen ws://...`.
- If no reachable WebSocket server is found, `cola` starts `codex app-server` over stdio.
- `--connect` must start with `ws://`.
