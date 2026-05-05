#!/usr/bin/env -S deno run --allow-run=codex,ps,git,vi --allow-read --allow-write --allow-env --allow-net=127.0.0.1,localhost

import { Command, EnumType } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";

type JsonRpcId = number | string;

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
  baseBranch: string;
};

const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_TIMEOUT_MS = 15_000;

const CLIENT_INFO = {
  name: "cola",
  title: "Codex Operator for Local Automation",
  version: "0.1.0",
};

class AppServerClient {
  #command: string;
  #process?: Deno.ChildProcess;
  #stdin?: WritableStreamDefaultWriter<Uint8Array>;
  #stdout?: ReadableStreamDefaultReader<Uint8Array>;
  #stderrReader?: ReadableStreamDefaultReader<Uint8Array>;
  #ws?: WebSocket;
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
      await this.#connectWebSocket(this.#connectUrl);
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

    this.#stdout?.cancel().catch(() => undefined);
    this.#stderrReader?.cancel().catch(() => undefined);
  }

  async #write(message: JsonRpcRequest) {
    if (this.#ws) {
      this.#ws.send(JSON.stringify(message));
      return;
    }

    if (!this.#stdin) throw new Error("app-server process is not started");
    await this.#stdin.write(this.#encoder.encode(`${JSON.stringify(message)}\n`));
  }

  async #readMessage(timeoutMs: number): Promise<unknown | undefined> {
    if (this.#ws) return await this.#readWebSocketMessage(timeoutMs);

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

const approvalPolicyType = new EnumType(["untrusted", "on-request", "on-failure", "never"]);
const sandboxType = new EnumType(["readOnly", "workspaceWrite", "dangerFullAccess"]);
const personalityType = new EnumType(["friendly", "pragmatic", "none"]);

const createCommand = addSessionOptions(new Command(), { cwd: true, worktree: true })
  .type("approval-policy", approvalPolicyType)
  .type("sandbox", sandboxType)
  .type("personality", personalityType)
  .arguments("[message...:string]")
  .description(
    "Creates a Codex app-server thread. By default, cola reuses a reachable local WebSocket app-server, then falls back to spawning `codex app-server` over stdio.",
  )
  .action(async (...args: unknown[]) => {
    const [rawOptions, ...messageParts] = args as [RawCreateOptions, ...string[]];
    await runCreateCommand({
      ...rawOptions,
      message: await resolveMessageAlias(messageParts),
    });
  });

const worktreeCommand = addSessionOptions(new Command(), { branch: true })
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
  .command("completions", new CompletionsCommand())
  .parse(Deno.args);

function addSessionOptions(
  command: Command,
  options: { cwd?: boolean; worktree?: boolean; branch?: boolean } = {},
): Command {
  command
    .option("--connect <url:string>", "Use an existing app-server WebSocket URL.")
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
      .option("--branch <branch:string>", "Base branch for --worktree. Defaults to main.");
  }
  if (options.branch) {
    command.option(
      "--branch <branch:string>",
      "Base branch for the new worktree. Defaults to main.",
    );
  }
  return command;
}

async function runCreateCommand(rawOptions: RawCreateOptions) {
  let exitCode = 0;
  let client: AppServerClient | undefined;
  try {
    const options = await createOptions(rawOptions);
    client = new AppServerClient(options.codexCommand, options.connect);
    await client.start();
    await client.initialize(options.timeoutMs);
    const thread = await client.startThread(options);
    const turn = thread.id && options.message
      ? await client.startTurn(thread.id, options.message, options)
      : undefined;

    printCreateResult({ thread, turn, options });
  } catch (error) {
    exitCode = 1;
    printError(error);
  } finally {
    await client?.close();
    Deno.exit(exitCode);
  }
}

async function runAction(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    printError(error);
    Deno.exit(1);
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
  };
  options.message ??= await promptMessageInEditor();

  if (options.worktree) {
    const description = options.message ?? "session";
    const worktree = await createWorktree(options.worktree, description, options.branch);
    options.cwd = worktree.path;
    options.worktreeInfo = worktree;
  }

  await validateOptions(options);
  if (!options.connect) {
    options.connect = await discoverAppServerWebSocket();
  }
  return options;
}

async function validateOptions(options: CreateOptions) {
  if (options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be greater than 0.");
  }
  if (options.connect && !options.connect.startsWith("ws://")) {
    throw new Error("--connect must be a ws:// URL.");
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

async function discoverAppServerWebSocket(): Promise<string | undefined> {
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
    for (const match of line.matchAll(/--listen(?:=|\s+)(ws:\/\/[^\s'"]+)/g)) {
      candidates.add(match[1]);
    }
  }

  for (const url of candidates) {
    if (await canConnectWebSocket(url)) return url;
  }
  return undefined;
}

async function createWorktree(
  repoName: string,
  _description: string,
  branch?: string,
): Promise<WorktreeInfo> {
  const repo = await resolveRepo(repoName);
  const id = await uniqueWorktreeId();
  const baseBranch = branch || repo.branch || "main";
  const parent = `${codexHome()}/worktrees/${id}`;
  const path = `${parent}/${basename(repo.path)}`;

  await Deno.mkdir(parent, { recursive: true });
  await runGit(["-C", repo.path, "worktree", "add", "--detach", path, baseBranch]);

  return {
    id,
    path,
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

async function canConnectWebSocket(url: string): Promise<boolean> {
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
