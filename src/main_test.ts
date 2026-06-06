const decoder = new TextDecoder();

Deno.test("create validates model instructions file", async () => {
  const fixture = await makeFixture({});
  const missingPath = `${fixture.tempDir}/missing.md`;

  const missing = await runCola(
    [
      "create",
      "--model-instructions-file",
      missingPath,
      "run tests",
    ],
    fixture,
    {
      COLA_SERVER_URL: "",
    },
  );
  assertEquals(missing.code, 1);
  assertIncludes(missing.stderr, `--model-instructions-file does not exist: ${missingPath}`);

  const directoryPath = `${fixture.tempDir}/instructions-dir`;
  await Deno.mkdir(directoryPath);
  const directory = await runCola(
    [
      "create",
      "--model-instructions-file",
      directoryPath,
      "run tests",
    ],
    fixture,
    {
      COLA_SERVER_URL: "",
    },
  );
  assertEquals(directory.code, 1);
  assertIncludes(
    directory.stderr,
    `--model-instructions-file must be a regular file: ${directoryPath}`,
  );
});

Deno.test("repo list uses cola server and writes audit JSONL", async () => {
  const fixture = await makeFixture({ resnet8: { path: "/repos/resnet8", branch: "main" } });
  const server = await startServer(fixture);
  try {
    const result = await runCola(["repo", "list"], fixture);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stdout, "resnet8\t/repos/resnet8\tmain\n");

    const audit = await readAudit(fixture.auditLog);
    assertEquals(audit.method, "repo/list");
    assertEquals(audit.ok, true);
  } finally {
    await stopServer(server);
  }
});

Deno.test("configured unavailable cola server fails unless local fallback is explicit", async () => {
  const fixture = await makeFixture({ resnet8: { path: "/repos/resnet8", branch: "main" } });
  fixture.serverUrl = `unix://${fixture.tempDir}/missing.sock`;

  const failed = await runCola(["repo", "list"], fixture);
  assertEquals(failed.code, 1);
  assertIncludes(failed.stderr, "COLA_SERVER_URL is configured but unavailable");
  assertEquals(failed.stdout, "");

  const fallback = await runCola(["repo", "list"], fixture, {
    COLA_ALLOW_LOCAL_FALLBACK: "1",
  });
  assertEquals(fallback.code, 0, fallback.stderr);
  assertEquals(fallback.stdout, "resnet8\t/repos/resnet8\tmain\n");
});

Deno.test("repo list discovers server from XDG_RUNTIME_DIR by default", async () => {
  const fixture = await makeFixture({ resnet8: { path: "/repos/resnet8", branch: "main" } });
  const runtimeDir = `${fixture.tempDir}/runtime`;
  fixture.serverUrl = `unix://${runtimeDir}/cola/server.sock`;
  const server = await startServer(fixture);
  try {
    const result = await runCola(["repo", "list"], fixture, {
      COLA_SERVER_URL: "",
      XDG_RUNTIME_DIR: runtimeDir,
    });
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stdout, "resnet8\t/repos/resnet8\tmain\n");

    const audit = await readAudit(fixture.auditLog);
    assertEquals(audit.method, "repo/list");
    assertEquals(audit.ok, true);
  } finally {
    await stopServer(server);
  }
});

Deno.test("unavailable default cola server socket fails instead of local fallback", async () => {
  const fixture = await makeFixture({ resnet8: { path: "/repos/resnet8", branch: "main" } });
  await Deno.mkdir(`${fixture.tempDir}/runtime/cola`, { recursive: true });
  await Deno.writeTextFile(`${fixture.tempDir}/runtime/cola/server.sock`, "stale");
  fixture.serverUrl = "";

  const failed = await runCola(["repo", "list"], fixture, {
    XDG_RUNTIME_DIR: `${fixture.tempDir}/runtime`,
  });
  assertEquals(failed.code, 1);
  assertIncludes(failed.stderr, "default cola server socket is configured but unavailable");

  const fallback = await runCola(["repo", "list"], fixture, {
    XDG_RUNTIME_DIR: `${fixture.tempDir}/runtime`,
    COLA_ALLOW_LOCAL_FALLBACK: "1",
  });
  assertEquals(fallback.code, 0, fallback.stderr);
  assertEquals(fallback.stdout, "resnet8\t/repos/resnet8\tmain\n");
});

Deno.test("server rejects worktree repo outside repo allowlist", async () => {
  const fixture = await makeFixture({ resnet8: { path: "/repos/resnet8", branch: "main" } });
  const server = await startServer(fixture);
  try {
    const result = await runCola(["worktree", "unknown", "task"], fixture);
    assertEquals(result.code, 1);
    assertIncludes(result.stderr, "Repo unknown is not allowed by the cola server repo allowlist");

    const audit = await readAudit(fixture.auditLog);
    assertEquals(audit.method, "worktree/create-session");
    assertEquals(audit.ok, false);
  } finally {
    await stopServer(server);
  }
});

Deno.test("bd next requires controlPlaneDb config", async () => {
  const fixture = await makeFixture({ resnet8: { path: "/repos/resnet8", branch: "main" } });

  const result = await runCola(["bd", "next", "resnet8"], fixture, {
    COLA_SERVER_URL: "",
  });

  assertEquals(result.code, 1);
  assertIncludes(
    result.stderr,
    "cola bd next requires config 'controlPlaneDb'. Set it with: cola config set controlPlaneDb <path>",
  );
});

Deno.test("bd next targets the configured control-plane DB", async () => {
  const fixture = await makeFixture({ resnet8: { path: "/repos/resnet8", branch: "main" } });
  const repoPath = `${fixture.tempDir}/repos/resnet8`;
  const controlPlaneDb = `${fixture.tempDir}/control-plane`;
  await Deno.mkdir(repoPath, { recursive: true });
  await Deno.mkdir(controlPlaneDb, { recursive: true });
  await writeFixtureConfig(fixture, {
    repos: { resnet8: { path: repoPath, branch: "main" } },
    controlPlaneDb,
  });

  const fakes = await installBdNextFakes(fixture);

  const result = await runCola(
    [
      "bd",
      "next",
      "resnet8",
      "--codex-command",
      `${fakes.binDir}/codex`,
      "--timeout-ms",
      "5000",
      "--wait-pr",
      "--timeout",
      "1",
      "--poll-interval",
      "1",
    ],
    fixture,
    {
      COLA_SERVER_URL: "",
      PATH: `${fakes.binDir}:${Deno.env.get("PATH") ?? ""}`,
    },
  );

  assertEquals(result.code, 0, result.stderr);

  const bdCalls = await readJsonl(fakes.bdLog);
  assertJsonEquals(bdCalls[0]?.args, [
    "-C",
    controlPlaneDb,
    "ready",
    "--label",
    "repo:resnet8",
    "--claim",
    "--json",
    "--limit",
    "1",
  ]);

  const updateCalls = bdCalls.filter((call) => asStringArray(call.args).includes("update"));
  assertEquals(updateCalls.some((call) => asStringArray(call.args).includes("--claim")), false);
  assertEquals(updateCalls.length, 1);
  assertJsonEquals(asStringArray(updateCalls[0].args).slice(0, 4), [
    "-C",
    controlPlaneDb,
    "update",
    "bd-123",
  ]);
  assertEquals(asStringArray(updateCalls[0].args).includes("cola.session_id=thread-1"), true);
  assertEquals(asStringArray(updateCalls[0].args).includes("cola.state=session-started"), true);

  const showCall = bdCalls.find((call) => asStringArray(call.args).includes("show"));
  assertJsonEquals(showCall?.args, ["-C", controlPlaneDb, "show", "bd-123", "--json"]);

  const codexCalls = await readJsonl(fakes.codexLog);
  const turnStart = codexCalls.find((call) => call.method === "turn/start");
  const input = asRecord(turnStart?.params).input;
  if (!Array.isArray(input)) throw new Error("turn/start input was not recorded.");
  const prompt = asRecord(input[0]).text;
  if (typeof prompt !== "string") throw new Error("turn/start prompt was not recorded.");
  assertIncludes(prompt, `bd -C ${controlPlaneDb} show bd-123 --long`);
  assertIncludes(
    prompt,
    `bd -C ${controlPlaneDb} update bd-123 --set-metadata cola.pr_url=<PR URL> --set-metadata cola.state=pr-opened`,
  );
});

type Fixture = {
  tempDir: string;
  xdgConfigHome: string;
  serverUrl: string;
  auditLog: string;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function makeFixture(
  repos: Record<string, { path: string; branch: string }>,
): Promise<Fixture> {
  const tempDir = await Deno.makeTempDir({ prefix: "cola-server-test-" });
  const xdgConfigHome = `${tempDir}/config`;
  await Deno.mkdir(`${xdgConfigHome}/cola`, { recursive: true });

  const fixture = {
    tempDir,
    xdgConfigHome,
    serverUrl: `unix://${tempDir}/server.sock`,
    auditLog: `${tempDir}/audit.jsonl`,
  };
  await writeFixtureConfig(fixture, { repos });
  return fixture;
}

async function writeFixtureConfig(fixture: Fixture, config: Record<string, unknown>) {
  await Deno.writeTextFile(
    `${fixture.xdgConfigHome}/cola/config.json`,
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

async function startServer(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
): Promise<Deno.ChildProcess> {
  const command = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-all",
      "src/main.ts",
      "server",
      "--listen",
      fixture.serverUrl,
      "--audit-log",
      fixture.auditLog,
    ],
    env: commandEnv(fixture, extraEnv),
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
  const child = command.spawn();
  await waitForSocket(fixture.serverUrl);
  return child;
}

async function stopServer(child: Deno.ChildProcess) {
  child.kill("SIGTERM");
  await child.status.catch(() => undefined);
}

async function runCola(
  args: string[],
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
): Promise<CommandResult> {
  const command = new Deno.Command("deno", {
    args: ["run", "--allow-all", "src/main.ts", ...args],
    env: commandEnv(fixture, extraEnv),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

function commandEnv(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  return {
    ...Deno.env.toObject(),
    XDG_CONFIG_HOME: fixture.xdgConfigHome,
    HOME: fixture.tempDir,
    CODEX_HOME: `${fixture.tempDir}/codex`,
    COLA_SERVER_URL: fixture.serverUrl,
    ...extraEnv,
  };
}

async function waitForSocket(url: string) {
  const path = new URL(url).pathname;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const conn = await Deno.connect({ transport: "unix", path }).catch(() => undefined);
    if (conn) {
      conn.close();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function readAudit(path: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const text = await Deno.readTextFile(path).catch(() => "");
    const line = text.trim().split("\n").find(Boolean);
    if (line) return JSON.parse(line);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for audit log ${path}`);
}

async function installBdNextFakes(fixture: Fixture): Promise<{
  binDir: string;
  bdLog: string;
  codexLog: string;
}> {
  const binDir = `${fixture.tempDir}/bin`;
  const bdLog = `${fixture.tempDir}/bd.jsonl`;
  const codexLog = `${fixture.tempDir}/codex.jsonl`;
  const gitLog = `${fixture.tempDir}/git.jsonl`;
  await Deno.mkdir(binDir, { recursive: true });

  await writeExecutable(
    `${binDir}/bd`,
    `#!/usr/bin/env -S deno run --allow-write
const logPath = ${JSON.stringify(bdLog)};
await Deno.writeTextFile(
  logPath,
  JSON.stringify({ cwd: Deno.cwd(), args: Deno.args }) + "\\n",
  { append: true, create: true },
);

if (Deno.args.includes("ready")) {
  console.log(JSON.stringify([{ id: "bd-123", title: "Fixture task", status: "in_progress" }]));
} else if (Deno.args.includes("show")) {
  console.log(JSON.stringify({
    id: "bd-123",
    metadata: {
      "cola.state": "pr-opened",
    },
  }));
}
`,
  );

  await writeExecutable(
    `${binDir}/codex`,
    `#!/usr/bin/env -S deno run --allow-read --allow-write
const logPath = ${JSON.stringify(codexLog)};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buffer = "";

for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) await handle(line);
    newline = buffer.indexOf("\\n");
  }
}

async function handle(line) {
  const request = JSON.parse(line);
  await Deno.writeTextFile(
    logPath,
    JSON.stringify({ method: request.method, params: request.params }) + "\\n",
    { append: true, create: true },
  );
  if (request.id === undefined) return;

  let result = {};
  if (request.method === "thread/start") result = { thread: { id: "thread-1" } };
  if (request.method === "turn/start") result = { turn: { id: "turn-1" } };
  await Deno.stdout.write(encoder.encode(JSON.stringify({ id: request.id, result }) + "\\n"));
}
`,
  );

  await writeExecutable(
    `${binDir}/git`,
    `#!/usr/bin/env -S deno run --allow-write
const logPath = ${JSON.stringify(gitLog)};
await Deno.writeTextFile(
  logPath,
  JSON.stringify({ cwd: Deno.cwd(), args: Deno.args }) + "\\n",
  { append: true, create: true },
);

const worktreeIndex = Deno.args.indexOf("worktree");
if (worktreeIndex >= 0 && Deno.args[worktreeIndex + 1] === "add") {
  const path = Deno.args[Deno.args.length - 2];
  await Deno.mkdir(path, { recursive: true });
}
`,
  );

  await writeExecutable(
    `${binDir}/ps`,
    `#!/usr/bin/env sh
exit 0
`,
  );

  return { binDir, bdLog, codexLog };
}

async function writeExecutable(path: string, content: string) {
  await Deno.writeTextFile(path, content);
  await Deno.chmod(path, 0o755);
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const text = await Deno.readTextFile(path);
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function assertEquals(actual: unknown, expected: unknown, message?: string) {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertIncludes(actual: string, expected: string) {
  if (!actual.includes(expected)) {
    throw new Error(`Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  }
}

function assertJsonEquals(actual: unknown, expected: unknown) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected string array, got ${JSON.stringify(value)}`);
  }
  return value;
}
