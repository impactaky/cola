#!/usr/bin/env -S deno run --allow-run=bd,codex,ps,git,vi,gh --allow-read --allow-write --allow-env --allow-net=127.0.0.1,localhost

import { Command, EnumType } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";

type JsonRpcId = number | string;

type ByteArray = Uint8Array<ArrayBufferLike>;

type JsonRpcRequest = {
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  id?: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type ThreadSummary = {
  id?: string;
  preview?: string;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
};

type TurnSummary = {
  id?: string;
  status?: unknown;
};

type AppServerTransport = "websocket" | "unix";

type CreateOptions = {
  codexCommand: string;
  connect?: string;
  cwd: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  personality?: string;
  message?: string;
  timeoutMs: number;
  json: boolean;
  worktree?: string;
  branch?: string;
  newBranch?: string;
  worktreeInfo?: WorktreeInfo;
};

type RawCreateOptions = Record<string, unknown>;

type Config = {
  repos?: Record<string, RepoConfig>;
  aliases?: Record<string, string>;
};

type RepoConfig = {
  path: string;
  branch?: string;
};

type WorktreeInfo = {
  id: string;
  path: string;
  branch: string | null;
  baseBranch: string;
};

type BdNextTask = {
  task: string;
  branch: string;
  baseBranch: string;
};

type BdNextResult = {
  task: string;
  repoPath: string;
};

type BdWaitPrOptions = {
  timeoutSeconds: number;
  pollIntervalSeconds: number;
};

type BdIssue = {
  id?: string;
  title?: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BD_WAIT_PR_TIMEOUT_SECONDS = 30 * 60;
const DEFAULT_BD_WAIT_PR_POLL_INTERVAL_SECONDS = 10;

const CLIENT_INFO = {
  name: "cola",
  title: "Codex Operator for Local Automation",
  version: "0.1.0",
};

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class AppServerClient {
  #command: string;
  #process?: Deno.ChildProcess;
  #stdin?: WritableStreamDefaultWriter<Uint8Array>;
  #stdout?: ReadableStreamDefaultReader<Uint8Array>;
  #stderrReader?: ReadableStreamDefaultReader<Uint8Array>;
  #ws?: WebSocket;
  #unixWs?: UnixWebSocket;
  #wsMessages: unknown[] = [];
  #wsWaiters: Array<(value: unknown | undefined) => void> = [];
  #stderr = "";
  #buffer = "";
  #nextId = 1;
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();

  constructor(command: string, connect?: string) {
    this.#command = command;
    if (connect) this.#connectUrl = connect;
  }

  #connectUrl?: string;

  async start() {
    if (this.#connectUrl) {
      await this.#connectTransport(this.#connectUrl);
      return;
    }

    const child = new Deno.Command(this.#command, {
      args: ["app-server"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    this.#process = child;
    this.#stdin = child.stdin.getWriter();
    this.#stdout = child.stdout.getReader();
    this.#collectStderr(child.stderr);
  }

  async initialize(timeoutMs: number) {
    await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
      },
    }, timeoutMs);
    await this.notify("initialized");
  }

  async startThread(options: CreateOptions): Promise<ThreadSummary> {
    const params = sessionParams(options);
    const result = await this.request("thread/start", params, options.timeoutMs);
    const thread = asRecord(result).thread;
    if (!isRecord(thread)) {
      throw new Error(`thread/start response did not contain result.thread: ${stringify(result)}`);
    }
    return thread as ThreadSummary;
  }

  async startTurn(threadId: string, message: string, options: CreateOptions): Promise<TurnSummary> {
    const params: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text: message }],
    };
    Object.assign(params, turnParams(options));

    const result = await this.request("turn/start", params, options.timeoutMs);
    const turn = asRecord(result).turn;
    if (!isRecord(turn)) {
      throw new Error(`turn/start response did not contain result.turn: ${stringify(result)}`);
    }
    return turn as TurnSummary;
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = this.#nextId++;
    await this.#write({ id, method, params });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const message = await this.#readMessage(remaining);
      if (!message) break;

      if (isRecord(message) && message.id === id) {
        const response = message as JsonRpcResponse;
        if (response.error) {
          const detail = response.error.data ? ` ${stringify(response.error.data)}` : "";
          throw new Error(
            `${method} failed: ${response.error.message ?? "unknown error"}${detail}`,
          );
        }
        return response.result;
      }
    }

    const stderr = this.#stderr.trim();
    throw new Error(
      `Timed out waiting for ${method} response after ${timeoutMs}ms${
        stderr ? `\napp-server stderr:\n${stderr}` : ""
      }`,
    );
  }

  async notify(method: string, params?: Record<string, unknown>) {
    await this.#write({ method, params });
  }

  async close() {
    try {
      await this.#stdin?.close();
    } catch {
      // Process may already have exited.
    }
    try {
      this.#process?.kill("SIGTERM");
    } catch {
      // Process may already have exited.
    }
    this.#ws?.close();
    this.#unixWs?.close();

    this.#stdout?.cancel().catch(() => undefined);
    this.#stderrReader?.cancel().catch(() => undefined);
  }

  async #write(message: JsonRpcRequest) {
    const text = JSON.stringify(message);
    if (this.#ws) {
      this.#ws.send(text);
      return;
    }
    if (this.#unixWs) {
      await this.#unixWs.send(text);
      return;
    }

    if (!this.#stdin) throw new Error("app-server process is not started");
    await this.#stdin.write(this.#encoder.encode(`${text}\n`));
  }

  async #readMessage(timeoutMs: number): Promise<unknown | undefined> {
    if (this.#ws || this.#unixWs) return await this.#readWebSocketMessage(timeoutMs);

    if (!this.#stdout) throw new Error("app-server process is not started");

    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        return JSON.parse(line);
      }

      const read = this.#stdout.read();
      const timeout = new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), timeoutMs)
      );
      const result = await Promise.race([read, timeout]);
      if (!result) return undefined;
      if (result.done) return undefined;
      this.#buffer += this.#decoder.decode(result.value, { stream: true });
    }
  }

  async #connectTransport(url: string) {
    if (transportForUrl(url) === "unix") {
      await this.#connectUnixWebSocket(url);
      return;
    }
    await this.#connectWebSocket(url);
  }

  async #collectStderr(stderr: ReadableStream<Uint8Array>) {
    const reader = stderr.getReader();
    this.#stderrReader = reader;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        this.#stderr += this.#decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      // Best effort diagnostics only.
    }
  }

  async #connectWebSocket(url: string) {
    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.onmessage = (event) => {
      const value = JSON.parse(String(event.data));
      const waiter = this.#wsWaiters.shift();
      if (waiter) {
        waiter(value);
      } else {
        this.#wsMessages.push(value);
      }
    };

    ws.onerror = () => {
      this.#resolveWebSocketWaiters(undefined);
    };
    ws.onclose = () => {
      this.#resolveWebSocketWaiters(undefined);
    };

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out connecting to ${url}`)), 5_000);
      ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        this.#resolveWebSocketWaiters(undefined);
        reject(new Error(`Failed to connect to ${url}`));
      };
    });
  }

  async #connectUnixWebSocket(url: string) {
    const unixWs = await UnixWebSocket.connect(url, 5_000);
    this.#unixWs = unixWs;

    unixWs.onmessage = (value) => {
      const waiter = this.#wsWaiters.shift();
      if (waiter) {
        waiter(value);
      } else {
        this.#wsMessages.push(value);
      }
    };

    unixWs.onclose = () => {
      this.#resolveWebSocketWaiters(undefined);
    };
  }

  async #readWebSocketMessage(timeoutMs: number): Promise<unknown | undefined> {
    const message = this.#wsMessages.shift();
    if (message) return message;

    return await new Promise<unknown | undefined>((resolve) => {
      const timeout = setTimeout(() => {
        const index = this.#wsWaiters.indexOf(resolve);
        if (index >= 0) this.#wsWaiters.splice(index, 1);
        resolve(undefined);
      }, timeoutMs);
      this.#wsWaiters.push((value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
  }

  #resolveWebSocketWaiters(value: unknown | undefined) {
    const waiters = this.#wsWaiters.splice(0);
    for (const waiter of waiters) waiter(value);
  }
}

class UnixWebSocket {
  #conn: Deno.Conn;
  #buffer: ByteArray;
  #closed = false;
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();
  onmessage?: (value: unknown) => void;
  onclose?: () => void;

  private constructor(conn: Deno.Conn, buffer: ByteArray) {
    this.#conn = conn;
    this.#buffer = buffer;
  }

  static async connect(url: string, timeoutMs: number): Promise<UnixWebSocket> {
    const path = unixSocketPath(url);
    const conn = await withTimeout(
      Deno.connect({ transport: "unix", path }),
      timeoutMs,
      `Timed out connecting to ${url}`,
    );
    const key = websocketKey();

    try {
      await writeAll(
        conn,
        new TextEncoder().encode(
          [
            "GET / HTTP/1.1",
            "Host: localhost",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        ),
      );

      const { header, remainder } = await readHttpHeader(conn, timeoutMs);
      await validateWebSocketHandshake(header, key, url);

      const websocket = new UnixWebSocket(conn, remainder);
      void websocket.#readLoop();
      return websocket;
    } catch (error) {
      try {
        conn.close();
      } catch {
        // Connection may already be closed.
      }
      if (error instanceof Error) throw error;
      throw new Error(`Failed to connect to ${url}`);
    }
  }

  async send(text: string) {
    if (this.#closed) throw new Error("app-server WebSocket is closed");
    await writeAll(this.#conn, encodeWebSocketFrame(0x1, this.#encoder.encode(text)));
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#conn.close();
    } catch {
      // Connection may already be closed.
    }
  }

  async #readLoop() {
    try {
      while (!this.#closed) {
        const frame = await this.#readFrame();
        if (!frame) break;

        if (frame.opcode === 0x1) {
          this.onmessage?.(JSON.parse(this.#decoder.decode(frame.payload)));
        } else if (frame.opcode === 0x8) {
          break;
        } else if (frame.opcode === 0x9) {
          await writeAll(this.#conn, encodeWebSocketFrame(0xA, frame.payload));
        }
      }
    } catch {
      // The caller observes connection loss as a closed WebSocket.
    } finally {
      this.close();
      this.onclose?.();
    }
  }

  async #readFrame(): Promise<{ opcode: number; payload: ByteArray } | undefined> {
    const header = await this.#readBytes(2);
    if (!header) return undefined;

    const opcode = header[0] & 0x0F;
    const masked = (header[1] & 0x80) !== 0;
    let length = header[1] & 0x7F;

    if (length === 126) {
      const extended = await this.#readBytes(2);
      if (!extended) return undefined;
      length = new DataView(extended.buffer, extended.byteOffset, extended.byteLength).getUint16(0);
    } else if (length === 127) {
      const extended = await this.#readBytes(8);
      if (!extended) return undefined;
      const value = new DataView(extended.buffer, extended.byteOffset, extended.byteLength)
        .getBigUint64(0);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WebSocket frame is too large");
      }
      length = Number(value);
    }

    const mask = masked ? await this.#readBytes(4) : undefined;
    const payload = await this.#readBytes(length);
    if (!payload) return undefined;

    if (mask) {
      for (let index = 0; index < payload.length; index++) {
        payload[index] ^= mask[index % 4];
      }
    }
    return { opcode, payload };
  }

  async #readBytes(length: number): Promise<ByteArray | undefined> {
    while (this.#buffer.length < length) {
      const chunk = new Uint8Array(8192);
      const read = await this.#conn.read(chunk);
      if (read === null) return undefined;
      this.#buffer = concatBytes(this.#buffer, chunk.slice(0, read));
    }

    const result = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
    return result;
  }
}

const approvalPolicyType = new EnumType(["untrusted", "on-request", "on-failure", "never"]);
const sandboxType = new EnumType(["readOnly", "workspaceWrite", "dangerFullAccess"]);
const personalityType = new EnumType(["friendly", "pragmatic", "none"]);

const createCommand = addSessionOptions(new Command(), { cwd: true, worktree: true })
  .type("approval-policy", approvalPolicyType)
  .type("sandbox", sandboxType)
  .type("personality", personalityType)
  .arguments("[message...:string]")
  .description(
    "Creates a Codex app-server thread. By default, cola reuses a reachable local app-server socket, then falls back to spawning `codex app-server` over stdio.",
  )
  .action(async (...args: unknown[]) => {
    const [rawOptions, ...messageParts] = args as [RawCreateOptions, ...string[]];
    await runCreateCommand({
      ...rawOptions,
      message: await resolveMessageAlias(messageParts),
    });
  });

const worktreeCommand = addSessionOptions(new Command(), { branch: true, newBranch: true })
  .type("approval-policy", approvalPolicyType)
  .type("sandbox", sandboxType)
  .type("personality", personalityType)
  .arguments("<repo-or-alias:string> [description...:string]")
  .description(
    "Creates a git worktree from a registered repository, then starts a Codex session in that worktree directory.",
  )
  .action(async (...args: unknown[]) => {
    const [rawOptions, repoOrAlias, ...descriptionParts] = args as [
      RawCreateOptions,
      string,
      ...string[],
    ];
    const worktreeArgs = await resolveWorktreeArgs(repoOrAlias, descriptionParts);
    await runCreateCommand({
      ...rawOptions,
      worktree: worktreeArgs.repo,
      message: worktreeArgs.message,
      cwd: Deno.cwd(),
    });
  });

const repoCommand = new Command()
  .description("Manage registered local repositories.")
  .command("register <name:string> [path:string]", "Register a local git repository by name.")
  .option("--branch <branch:string>", "Default branch for new worktrees.", { default: "main" })
  .action(async (options: RawCreateOptions, name: string, path?: string) => {
    await runAction(async () => {
      const repoPath = await gitRoot(path ?? Deno.cwd());
      await upsertRepo(name, { path: repoPath, branch: asString(options.branch) ?? "main" });
      console.log(`Registered repo ${name}: ${repoPath}`);
    });
  })
  .command("list", "List registered repositories.")
  .action(async () => {
    await runAction(async () => {
      const repos = (await readConfig()).repos ?? {};
      for (const [name, repo] of Object.entries(repos)) {
        console.log(`${name}\t${repo.path}\t${repo.branch ?? "main"}`);
      }
    });
  })
  .command("remove <name:string>", "Remove a registered repository.")
  .action(async (_options: void, name: string) => {
    await runAction(async () => {
      const config = await readConfig();
      if (!config.repos?.[name]) throw new Error(`No registered repo named ${name}.`);
      delete config.repos[name];
      await writeConfig(config);
      console.log(`Removed repo ${name}`);
    });
  });

const configCommand = new Command()
  .description("Manage cola configuration.")
  .command("get <key:string>", "Print a config value.")
  .action(async (_options: void, key: string) => {
    await runAction(async () => {
      const value = getConfigValue(await readConfig(), key);
      if (value === undefined) Deno.exit(1);
      console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    });
  })
  .command("set <key:string> <value:string>", "Set a config value.")
  .action(async (_options: void, key: string, value: string) => {
    await runAction(async () => {
      const config = await readConfig();
      setConfigValue(config, key, value);
      await writeConfig(config);
    });
  })
  .command("list", "List config values.")
  .action(async () => {
    await runAction(async () => {
      printConfig(await readConfig());
    });
  })
  .command("path", "Print the config file path.")
  .action(() => {
    console.log(configPath());
  })
  .reset();

const aliasCommand = new Command()
  .description("Manage description aliases.")
  .command("add <name:string> <prefix...:string>", "Register a description prefix alias.")
  .action(async (_options: void, name: string, ...prefixParts: string[]) => {
    await runAction(async () => {
      const prefix = prefixParts.join(" ");
      if (!prefix) throw new Error("Alias prefix cannot be empty.");
      await upsertAlias(name, prefix);
      console.log(`Registered alias ${name}: ${prefix}`);
    });
  })
  .command("list", "List description aliases.")
  .action(async () => {
    await runAction(async () => {
      const aliases = (await readConfig()).aliases ?? {};
      for (const [name, prefix] of Object.entries(aliases)) {
        console.log(`${name}\t${prefix}`);
      }
    });
  })
  .command("remove <name:string>", "Remove a description alias.")
  .action(async (_options: void, name: string) => {
    await runAction(async () => {
      const config = await readConfig();
      if (!config.aliases?.[name]) throw new Error(`No registered alias named ${name}.`);
      delete config.aliases[name];
      await writeConfig(config);
      console.log(`Removed alias ${name}`);
    });
  });

const bdCommand = new Command()
  .description("Run bd-backed Cola task automation.")
  .command("next <repo:string>", "Start one Codex session for the next ready bd task.")
  .type("approval-policy", approvalPolicyType)
  .type("sandbox", sandboxType)
  .type("personality", personalityType)
  .option("--base <branch:string>", "Base branch for the task worktree.")
  .option("--connect <url:string>", "Use an existing app-server ws:// or unix:// URL.")
  .option("--codex-command <command:string>", "Codex executable to run.", {
    default: DEFAULT_CODEX_COMMAND,
  })
  .option("--model <model:string>", "Model override for the new sessions.")
  .option("--approval-policy <policy:approval-policy>", "Approval policy override.")
  .option("--sandbox <mode:sandbox>", "Sandbox mode override.")
  .option("--personality <personality:personality>", "Codex personality override.")
  .option("--timeout-ms <ms:integer>", "Request timeout in milliseconds.", {
    default: DEFAULT_TIMEOUT_MS,
  })
  .option("--wait-pr", "Wait until the selected task records an open PR.", { default: false })
  .option("--timeout <seconds:integer>", "Seconds to wait for PR metadata.", {
    default: DEFAULT_BD_WAIT_PR_TIMEOUT_SECONDS,
  })
  .option("--poll-interval <seconds:integer>", "Seconds between bd show polls.", {
    default: DEFAULT_BD_WAIT_PR_POLL_INTERVAL_SECONDS,
  })
  .action(async (rawOptions: RawCreateOptions, repo: string) => {
    await runAction(async () => {
      const result = await runBdNextCommand(repo, rawOptions);
      if (rawOptions.waitPr === true && result) {
        await runBdWaitPr(result.task, rawOptions, result.repoPath);
      }
    });
  })
  .reset()
  .command("wait-pr <task-id:string>", "Wait until a bd task records an opened PR.")
  .option("--timeout <seconds:integer>", "Seconds to wait for PR metadata.", {
    default: DEFAULT_BD_WAIT_PR_TIMEOUT_SECONDS,
  })
  .option("--poll-interval <seconds:integer>", "Seconds between bd show polls.", {
    default: DEFAULT_BD_WAIT_PR_POLL_INTERVAL_SECONDS,
  })
  .action(async (rawOptions: RawCreateOptions, taskId: string) => {
    await runAction(async () => {
      await runBdWaitPr(taskId, rawOptions, Deno.cwd());
    });
  })
  .reset();

await new Command()
  .name("cola")
  .version("0.1.0")
  .description("Create Codex app-server sessions from the command line.")
  .type("approval-policy", approvalPolicyType)
  .type("sandbox", sandboxType)
  .type("personality", personalityType)
  .command("create", createCommand)
  .description("Create a Codex session and optionally start its first turn.")
  .reset()
  .command("worktree", worktreeCommand)
  .description("Create a repo worktree and start a Codex session.")
  .reset()
  .command("repo", repoCommand)
  .reset()
  .command("config", configCommand)
  .reset()
  .command("alias", aliasCommand)
  .reset()
  .command("bd", bdCommand)
  .reset()
  .command("completions", new CompletionsCommand())
  .parse(Deno.args);

function addSessionOptions(
  command: Command,
  options: { cwd?: boolean; worktree?: boolean; branch?: boolean; newBranch?: boolean } = {},
): Command {
  command
    .option("--connect <url:string>", "Use an existing app-server ws:// or unix:// URL.")
    .option("--codex-command <command:string>", "Codex executable to run.", {
      default: DEFAULT_CODEX_COMMAND,
    })
    .option("--model <model:string>", "Model override for the new session.")
    .option("--approval-policy <policy:approval-policy>", "Approval policy override.")
    .option("--sandbox <mode:sandbox>", "Sandbox mode override.")
    .option("--personality <personality:personality>", "Codex personality override.")
    .option("--timeout-ms <ms:integer>", "Request timeout in milliseconds.", {
      default: DEFAULT_TIMEOUT_MS,
    })
    .option("--json", "Print machine-readable output.", { default: false });

  if (options.cwd) {
    command.option("--cwd <path:string>", "Working directory for the Codex session.", {
      default: Deno.cwd(),
    });
  }
  if (options.worktree) {
    command
      .option("--worktree <repo:string>", "Create a git worktree from a registered repo first.")
      .option("--branch <branch:string>", "Base branch for --worktree. Defaults to main.")
      .option("--new-branch <branch:string>", "Create and check out a new worktree branch.");
  }
  if (options.branch) {
    command.option(
      "--branch <branch:string>",
      "Base branch for the new worktree. Defaults to main.",
    );
  }
  if (options.newBranch) {
    command.option("--new-branch <branch:string>", "Create and check out a new worktree branch.");
  }
  return command;
}

async function runCreateCommand(rawOptions: RawCreateOptions) {
  let exitCode = 0;
  try {
    const { thread, turn, options } = await createSession(rawOptions);
    printCreateResult({ thread, turn, options });
  } catch (error) {
    exitCode = 1;
    printError(error);
  }
  Deno.exit(exitCode);
}

async function runAction(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    printError(error);
    Deno.exit(1);
  }
}

async function runBdNextCommand(
  repoName: string,
  rawOptions: RawCreateOptions,
): Promise<BdNextResult | undefined> {
  const repo = await resolveRepo(repoName);
  const issue = await bdReadyOne(repo.path);
  if (!issue) {
    console.log("No ready bd tasks found.");
    return undefined;
  }

  const task = bdIssueId(issue);
  if (!task) {
    throw new Error(`bd ready --json did not return a task id: ${stringify(issue)}`);
  }
  const item: BdNextTask = {
    task,
    branch: `bd/${sanitizeBranchPart(task)}`,
    baseBranch: asString(rawOptions.base) ?? repo.branch ?? "main",
  };

  await bdUpdate(repo.path, item.task, ["--claim"]);

  const message = buildBdNextPrompt(item);
  const { thread, turn, options } = await createSession({
    ...rawOptions,
    json: false,
    message,
    worktree: repoName,
    branch: item.baseBranch,
    newBranch: item.branch,
    cwd: Deno.cwd(),
  });

  const sessionId = thread.id;
  if (!sessionId) throw new Error(`Codex did not return a session id for ${item.task}.`);
  const turnId = turn?.id;
  if (!turnId) throw new Error(`Codex did not return a turn id for ${item.task}.`);
  const worktreePath = options.worktreeInfo?.path;
  if (!worktreePath) throw new Error(`Worktree was not created for ${item.task}.`);
  const baseBranch = options.worktreeInfo?.baseBranch ?? item.baseBranch;

  await bdUpdateMetadata(repo.path, item.task, {
    "cola.session_id": sessionId,
    "cola.turn_id": turnId,
    "cola.worktree": worktreePath,
    "cola.branch": item.branch,
    "cola.base_branch": baseBranch,
    "cola.state": "session-started",
  });

  console.log(`Started ${item.task}`);
  console.log(`  session: ${sessionId}`);
  console.log(`  turn: ${turnId}`);
  console.log(`  worktree: ${worktreePath}`);
  console.log(`  branch: ${item.branch}`);
  console.log(`  base: ${baseBranch}`);
  return { task: item.task, repoPath: repo.path };
}

async function runBdWaitPr(
  task: string,
  rawOptions: RawCreateOptions,
  repoPath: string,
) {
  const options = bdWaitPrOptions(rawOptions);
  const result = await waitForBdPr(repoPath, task, options);
  console.log(`PR recorded for ${task}: ${result.prUrl ?? "cola.state=pr-opened"}`);
  if (result.prUrl) {
    await verifyPrUrlWithGh(result.prUrl);
  }
}

function bdWaitPrOptions(rawOptions: RawCreateOptions): BdWaitPrOptions {
  const timeoutSeconds = asNumber(rawOptions.timeout) ?? DEFAULT_BD_WAIT_PR_TIMEOUT_SECONDS;
  const pollIntervalSeconds = asNumber(rawOptions.pollInterval) ??
    DEFAULT_BD_WAIT_PR_POLL_INTERVAL_SECONDS;
  if (timeoutSeconds <= 0) throw new Error("--timeout must be greater than 0.");
  if (pollIntervalSeconds <= 0) throw new Error("--poll-interval must be greater than 0.");
  return { timeoutSeconds, pollIntervalSeconds };
}

async function waitForBdPr(
  repoPath: string,
  task: string,
  options: BdWaitPrOptions,
): Promise<{ prUrl?: string }> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let lastState = "";

  while (true) {
    const issue = await bdShow(repoPath, task);
    const state = bdMetadataString(issue, "cola.state");
    const prUrl = bdMetadataString(issue, "cola.pr_url");
    lastState = state ?? "";

    if (state === "failed") {
      throw new Error(`bd task ${task} recorded cola.state=failed.`);
    }
    if (state === "pr-opened" || prUrl) {
      return { prUrl };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const suffix = lastState ? ` Last cola.state=${lastState}.` : "";
      throw new Error(
        `Timed out waiting ${options.timeoutSeconds}s for ${task} to record cola.state=pr-opened or cola.pr_url.${suffix}`,
      );
    }

    await sleep(Math.min(options.pollIntervalSeconds * 1000, remainingMs));
  }
}

async function bdReadyOne(repoPath: string): Promise<BdIssue | undefined> {
  const output = await runBd(repoPath, ["ready", "--json", "--limit", "1"]);
  const parsed = JSON.parse(output);
  return firstBdIssue(parsed);
}

async function bdShow(repoPath: string, task: string): Promise<Record<string, unknown>> {
  const output = await runBd(repoPath, ["show", task, "--json"]);
  return asRecord(JSON.parse(output));
}

function firstBdIssue(value: unknown): BdIssue | undefined {
  if (Array.isArray(value)) {
    const first = value.find((item) => isRecord(item) && bdIssueId(item));
    return first ? first as BdIssue : undefined;
  }
  if (!isRecord(value)) return undefined;
  if (bdIssueId(value)) return value as BdIssue;

  for (const key of ["issues", "items", "tasks", "ready", "results"]) {
    const nested = firstBdIssue(value[key]);
    if (nested) return nested;
  }
  return undefined;
}

function bdIssueId(issue: Record<string, unknown>): string | undefined {
  for (const key of ["id", "task", "issue", "name", "ID"]) {
    const value = issue[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function buildBdNextPrompt(item: BdNextTask): string {
  return [
    `Implement bd task ${item.task}.`,
    "",
    "You are working in a dedicated git worktree and branch for this task.",
    "",
    "Task context:",
    `- Task: ${item.task}`,
    `- Branch: ${item.branch}`,
    `- Base branch: ${item.baseBranch}`,
    "",
    "Instructions:",
    `- Run \`bd show ${item.task} --long\` first and keep the change scoped to that task.`,
    "- Implement the requested change.",
    "- Run the relevant checks for the repository.",
    "- Commit the completed work on this branch.",
    "- Push the branch.",
    `- Create a PR with base \`${item.baseBranch}\` and head \`${item.branch}\`.`,
    "- Do not merge the PR.",
    "- After opening the PR, update bd metadata with:",
    `  - \`bd update ${item.task} --set-metadata cola.pr_url=<PR URL> --set-metadata cola.state=pr-opened\``,
    "- Leave human review and merge manual.",
  ].join("\n");
}

async function bdUpdate(repoPath: string, task: string, args: string[]) {
  await runBd(repoPath, ["update", task, ...args]);
}

async function bdUpdateMetadata(
  repoPath: string,
  task: string,
  metadata: Record<string, string>,
) {
  const args = Object.entries(metadata).flatMap(([key, value]) => [
    "--set-metadata",
    `${key}=${value}`,
  ]);
  await bdUpdate(repoPath, task, args);
}

async function runBd(repoPath: string, args: string[]): Promise<string> {
  const command = new Deno.Command("bd", {
    args,
    cwd: repoPath,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (!output.success) throw new Error(stderr || `bd ${args.join(" ")} failed`);
  return stdout;
}

function bdMetadataString(issue: Record<string, unknown>, key: string): string | undefined {
  const direct = asNonEmptyString(issue[key]);
  if (direct) return direct;

  const metadata = issue.metadata;
  if (isRecord(metadata)) {
    const metadataDirect = asNonEmptyString(metadata[key]);
    if (metadataDirect) return metadataDirect;
  }

  const dotted = key.split(".");
  return asNonEmptyString(readPath(issue, dotted)) ??
    (isRecord(metadata) ? asNonEmptyString(readPath(metadata, dotted)) : undefined);
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function verifyPrUrlWithGh(prUrl: string) {
  let output: Deno.CommandOutput;
  try {
    const command = new Deno.Command("gh", {
      args: ["pr", "view", prUrl, "--json", "url,state"],
      stdout: "piped",
      stderr: "piped",
    });
    output = await command.output();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }

  if (output.success) {
    console.log(`Verified PR with gh: ${prUrl}`);
    return;
  }

  const stderr = new TextDecoder().decode(output.stderr).trim();
  console.error(`Warning: gh pr view could not verify ${prUrl}${stderr ? `: ${stderr}` : "."}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeBranchPart(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error(`Cannot derive branch name from task id: ${value}`);
  }
  return sanitized;
}

async function createSession(rawOptions: RawCreateOptions): Promise<{
  thread: ThreadSummary;
  turn?: TurnSummary;
  options: CreateOptions;
}> {
  let client: AppServerClient | undefined;
  const options = await createOptions(rawOptions);
  try {
    client = new AppServerClient(options.codexCommand, options.connect);
    await client.start();
    await client.initialize(options.timeoutMs);
    const thread = await client.startThread(options);
    const turn = thread.id && options.message
      ? await client.startTurn(thread.id, options.message, options)
      : undefined;
    return { thread, turn, options };
  } finally {
    await client?.close();
  }
}

async function resolveMessageAlias(parts: string[]): Promise<string | undefined> {
  return resolveMessageAliasFromConfig(await readConfig(), parts);
}

function resolveMessageAliasFromConfig(
  config: Config,
  parts: string[],
): string | undefined {
  if (parts.length === 0) return undefined;

  const [first, ...rest] = parts;
  const prefix = config.aliases?.[first];
  if (prefix === undefined) return parts.join(" ");
  return `${prefix}${rest.join(" ")}`;
}

async function resolveWorktreeArgs(
  repoOrAlias: string,
  descriptionParts: string[],
): Promise<{ repo: string; message: string | undefined }> {
  const config = await readConfig();
  const firstTokenIsAlias = config.aliases?.[repoOrAlias] !== undefined;
  const firstTokenLooksLikeRepo = config.repos?.[repoOrAlias] !== undefined ||
    Boolean((await Deno.stat(repoOrAlias).catch(() => undefined))?.isDirectory);

  if (firstTokenIsAlias && !firstTokenLooksLikeRepo) {
    return {
      repo: Deno.cwd(),
      message: resolveMessageAliasFromConfig(config, [repoOrAlias, ...descriptionParts]),
    };
  }

  return {
    repo: repoOrAlias,
    message: resolveMessageAliasFromConfig(config, descriptionParts),
  };
}

async function createOptions(rawOptions: RawCreateOptions): Promise<CreateOptions> {
  const options: CreateOptions = {
    codexCommand: asString(rawOptions.codexCommand) ?? DEFAULT_CODEX_COMMAND,
    connect: asString(rawOptions.connect),
    cwd: asString(rawOptions.cwd) ?? Deno.cwd(),
    model: asString(rawOptions.model),
    approvalPolicy: asString(rawOptions.approvalPolicy),
    sandbox: asString(rawOptions.sandbox),
    personality: asString(rawOptions.personality),
    message: asString(rawOptions.message),
    timeoutMs: asNumber(rawOptions.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
    json: rawOptions.json === true,
    worktree: asString(rawOptions.worktree),
    branch: asString(rawOptions.branch),
    newBranch: asString(rawOptions.newBranch),
  };
  options.message ??= await promptMessageInEditor();

  if (options.worktree) {
    const description = options.message ?? "session";
    const worktree = await createWorktree(
      options.worktree,
      description,
      options.branch,
      options.newBranch,
    );
    options.cwd = worktree.path;
    options.worktreeInfo = worktree;
  }

  await validateOptions(options);
  if (!options.connect) {
    options.connect = await discoverAppServerSocket();
  }
  return options;
}

async function validateOptions(options: CreateOptions) {
  if (options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be greater than 0.");
  }
  if (options.connect && !transportForUrl(options.connect)) {
    throw new Error("--connect must be a ws:// or unix:// URL.");
  }

  const cwd = await Deno.stat(options.cwd).catch(() => undefined);
  if (!cwd) throw new Error(`--cwd does not exist: ${options.cwd}`);
  if (!cwd.isDirectory) throw new Error(`--cwd must be a directory: ${options.cwd}`);
}

function sessionParams(options: CreateOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (options.model) params.model = options.model;
  if (options.cwd) params.cwd = options.cwd;
  if (options.approvalPolicy) params.approvalPolicy = options.approvalPolicy;
  if (options.sandbox) params.sandbox = options.sandbox;
  if (options.personality) params.personality = options.personality;
  return params;
}

function turnParams(options: CreateOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (options.cwd) params.cwd = options.cwd;
  if (options.model) params.model = options.model;
  if (options.personality) params.personality = options.personality;
  return params;
}

function printCreateResult(
  { thread, turn, options }: { thread: ThreadSummary; turn?: TurnSummary; options: CreateOptions },
) {
  if (options.json) {
    console.log(JSON.stringify({ thread, turn, worktree: options.worktreeInfo }, null, 2));
    return;
  }

  if (options.worktreeInfo) {
    console.log(`Created worktree: ${options.worktreeInfo.path}`);
    console.log(`Worktree id: ${options.worktreeInfo.id}`);
    console.log(`Branch: ${options.worktreeInfo.branch ?? "detached"}`);
    console.log(`Base branch: ${options.worktreeInfo.baseBranch}`);
  }
  if (options.connect) console.log(`Connected app-server: ${options.connect}`);
  console.log(`Created Codex session: ${thread.id}`);
  if (turn?.id) console.log(`Started turn: ${turn.id}`);
  if (thread.modelProvider) console.log(`Model provider: ${thread.modelProvider}`);
  if (thread.preview) console.log(`Preview: ${thread.preview}`);
}

function printError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);

  if (message.includes("No such file or directory") || message.includes("os error 2")) {
    console.error("Hint: install Codex or pass --codex-command /path/to/codex.");
  } else if (message.includes("record cola.state=pr-opened or cola.pr_url")) {
    console.error("Hint: increase --timeout or check the task session status.");
  } else if (message.includes("read-only") || message.includes("Readonly")) {
    console.error("Hint: set CODEX_HOME to a writable directory before running cola.");
  } else if (message.includes("Timed out")) {
    console.error("Hint: increase --timeout-ms or check that the app-server is healthy.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected object, got ${stringify(value)}`);
  return value;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

async function promptMessageInEditor(): Promise<string> {
  const path = await Deno.makeTempFile({ prefix: "cola-message-", suffix: ".md" });
  try {
    const editor = Deno.env.get("VISUAL") || Deno.env.get("EDITOR") || "vi";
    const [editorCommand, ...editorArgs] = parseCommand(editor);
    const command = new Deno.Command(editorCommand, {
      args: [...editorArgs, path],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const output = await command.output();
    if (!output.success) {
      throw new Error(`Editor exited with status ${output.code}.`);
    }

    const message = (await Deno.readTextFile(path)).trim();
    if (!message) throw new Error("Aborted: message is empty.");
    return message;
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
}

function parseCommand(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: string | undefined;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (quote) throw new Error(`Invalid editor command: unmatched ${quote} quote.`);
  if (current) result.push(current);
  if (result.length === 0) throw new Error("Editor command cannot be empty.");
  return result;
}

async function discoverAppServerSocket(): Promise<string | undefined> {
  const command = new Deno.Command("ps", {
    args: ["-eo", "args="],
    stdout: "piped",
    stderr: "null",
  });
  const output = await command.output().catch(() => undefined);
  if (!output?.success) return undefined;

  const text = new TextDecoder().decode(output.stdout);
  const candidates = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.includes("app-server") || !line.includes("--listen")) continue;
    for (const match of line.matchAll(/--listen(?:=|\s+)(ws:\/\/[^\s'"]+|unix:\/\/[^\s'"]*)/g)) {
      candidates.add(match[1]);
    }
  }

  for (const url of candidates) {
    if (await canConnectAppServer(url)) return url;
  }
  return undefined;
}

async function createWorktree(
  repoName: string,
  _description: string,
  branch?: string,
  newBranch?: string,
): Promise<WorktreeInfo> {
  const repo = await resolveRepo(repoName);
  const id = await uniqueWorktreeId();
  const baseBranch = branch || repo.branch || "main";
  const parent = `${codexHome()}/worktrees/${id}`;
  const path = `${parent}/${basename(repo.path)}`;

  await Deno.mkdir(parent, { recursive: true });
  const args = newBranch
    ? ["-C", repo.path, "worktree", "add", "-b", newBranch, path, baseBranch]
    : ["-C", repo.path, "worktree", "add", "--detach", path, baseBranch];
  await runGit(args);

  return {
    id,
    path,
    branch: newBranch ?? null,
    baseBranch,
  };
}

async function resolveRepo(name: string): Promise<RepoConfig> {
  const config = await readConfig();
  const repo = config.repos?.[name];
  if (repo) return repo;

  const stat = await Deno.stat(name).catch(() => undefined);
  if (stat?.isDirectory) {
    return { path: await gitRoot(name), branch: "main" };
  }

  throw new Error(
    `No registered repo named ${name}. Register it with: cola repo register ${name} <path>`,
  );
}

async function upsertRepo(name: string, repo: RepoConfig) {
  validateConfigName(name, "Repo");
  const config = await readConfig();
  config.repos ??= {};
  config.repos[name] = repo;
  await writeConfig(config);
}

async function upsertAlias(name: string, prefix: string) {
  validateConfigName(name, "Alias");
  const config = await readConfig();
  config.aliases ??= {};
  config.aliases[name] = prefix;
  await writeConfig(config);
}

function validateConfigName(name: string, label: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(
      `${label} name may only contain letters, numbers, dots, underscores, and hyphens.`,
    );
  }
}

async function gitRoot(path: string): Promise<string> {
  const output = await runGit(["-C", path, "rev-parse", "--show-toplevel"]);
  return output.trim();
}

async function runGit(args: string[]): Promise<string> {
  const command = new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (!output.success) throw new Error(stderr || `git ${args.join(" ")} failed`);
  return stdout;
}

async function readConfig(): Promise<Config> {
  const path = configPath();
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Config;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { repos: {} };
    throw error;
  }
}

async function writeConfig(config: Config) {
  await Deno.mkdir(configDir(), { recursive: true });
  await Deno.writeTextFile(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function configPath(): string {
  return `${configDir()}/config.json`;
}

function configDir(): string {
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  if (xdg) return `${xdg}/cola`;

  const home = Deno.env.get("HOME");
  if (home) return `${home}/.config/cola`;

  throw new Error("Cannot determine XDG config directory: HOME is not set.");
}

function codexHome(): string {
  const home = Deno.env.get("CODEX_HOME");
  if (home) return home;

  const userHome = Deno.env.get("HOME");
  if (userHome) return `${userHome}/.codex`;

  return `${Deno.cwd()}/.codex`;
}

function getConfigValue(config: Config, key: string): unknown {
  let current: unknown = config;
  for (const part of key.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setConfigValue(config: Config, key: string, value: unknown) {
  const parts = key.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("Config key cannot be empty.");

  let current: Record<string, unknown> = config;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current[part])) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function printConfig(value: unknown, prefix = "") {
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      printConfig(child, prefix ? `${prefix}.${key}` : key);
    }
    return;
  }
  console.log(`${prefix}=${String(value)}`);
}

async function uniqueWorktreeId(): Promise<string> {
  while (true) {
    const id = randomHex(2);
    const path = `${codexHome()}/worktrees/${id}`;
    if (!await exists(path)) return id;
  }
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(
    () => true,
    () => false,
  );
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/g, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function transportForUrl(url: string): AppServerTransport | undefined {
  if (url.startsWith("ws://")) return "websocket";
  if (url.startsWith("unix://")) return "unix";
  return undefined;
}

function unixSocketPath(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "unix:") throw new Error();
    if (!parsed.host && !parsed.pathname) return defaultAppServerSocketPath();
    const path = parsed.pathname;
    if (!path) throw new Error();
    return decodeURIComponent(path);
  } catch {
    throw new Error(`Invalid unix:// URL: ${url}`);
  }
}

function defaultAppServerSocketPath(): string {
  return `${codexHome()}/app-server-control/app-server-control.sock`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function writeAll(writer: { write(bytes: ByteArray): Promise<number> }, bytes: ByteArray) {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await writer.write(bytes.slice(offset));
  }
}

async function readHttpHeader(
  conn: Deno.Conn,
  timeoutMs: number,
): Promise<{ header: string; remainder: ByteArray }> {
  let buffer: ByteArray = new Uint8Array(0);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const chunk = new Uint8Array(4096);
    const read = await withTimeout(
      conn.read(chunk),
      Math.max(1, deadline - Date.now()),
      "Timed out waiting for WebSocket handshake",
    );
    if (read === null) break;
    buffer = concatBytes(buffer, chunk.slice(0, read));

    const headerEnd = indexOfBytes(buffer, new TextEncoder().encode("\r\n\r\n"));
    if (headerEnd >= 0) {
      return {
        header: new TextDecoder().decode(buffer.slice(0, headerEnd)),
        remainder: buffer.slice(headerEnd + 4),
      };
    }
  }

  throw new Error("Failed to read WebSocket handshake");
}

async function validateWebSocketHandshake(header: string, key: string, url: string) {
  const lines = header.split("\r\n");
  const status = lines.shift() ?? "";
  if (!status.includes(" 101 ")) {
    throw new Error(`Failed to connect to ${url}: ${status || "invalid handshake"}`);
  }

  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }

  const expected = await websocketAccept(key);
  if (headers.get("sec-websocket-accept") !== expected) {
    throw new Error(`Failed to connect to ${url}: invalid WebSocket handshake`);
  }
}

function websocketKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64(bytes);
}

async function websocketAccept(key: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(`${key}${WEBSOCKET_GUID}`),
  );
  return base64(new Uint8Array(hash));
}

function encodeWebSocketFrame(opcode: number, payload: ByteArray): ByteArray {
  const mask = new Uint8Array(4);
  crypto.getRandomValues(mask);

  const lengthSize = payload.length < 126 ? 0 : payload.length <= 0xFFFF ? 2 : 8;
  const frame = new Uint8Array(2 + lengthSize + mask.length + payload.length);
  frame[0] = 0x80 | opcode;

  let offset = 2;
  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xFFFF) {
    frame[1] = 0x80 | 126;
    new DataView(frame.buffer).setUint16(offset, payload.length);
    offset += 2;
  } else {
    frame[1] = 0x80 | 127;
    new DataView(frame.buffer).setBigUint64(offset, BigInt(payload.length));
    offset += 8;
  }

  frame.set(mask, offset);
  offset += mask.length;

  for (let index = 0; index < payload.length; index++) {
    frame[offset + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

function concatBytes(left: ByteArray, right: ByteArray): ByteArray {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function indexOfBytes(buffer: ByteArray, pattern: ByteArray): number {
  for (let index = 0; index <= buffer.length - pattern.length; index++) {
    let matched = true;
    for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
      if (buffer[index + patternIndex] !== pattern[patternIndex]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

function base64(bytes: ByteArray): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function canConnectAppServer(url: string): Promise<boolean> {
  if (transportForUrl(url) === "unix") {
    const client = await UnixWebSocket.connect(url, 1_000).catch(() => undefined);
    client?.close();
    return client !== undefined;
  }

  return await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 1_000);

    ws.onopen = () => {
      clearTimeout(timeout);
      ws.close();
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
  });
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
