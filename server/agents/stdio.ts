import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { McpClientError, type McpTransport } from "./mcpClient";

/**
 * stdio MCP servers (plan §3.3, D348, T308; Wave 41 AC-B): never configured from the UI. With
 * `AGENT_MCP_STDIO=on`, the host declares them in `AGENT_MCP_STDIO_FILE`, a JSON array of
 * `{ id, name, command (absolute path), args?: string[], env?: { NAME: value } }`, read once at
 * startup. With the flag off the file is ignored whatever it holds. An admin then adopts a declared
 * server as a tool server (transport `stdio`), and the Settings row says "Declared by the host ·
 * runs as Nook's user".
 *
 * The child gets only the declared variables (nothing of Nook's environment: no `*_KEY`, `DATABASE`,
 * `RESEND_*`), an empty temporary cwd, 5 s to start, the server's tool timeout per call, 1 MiB of
 * stdout per message, one process per server, and at most 3 restarts in 10 minutes. OPERATIONS
 * recommends an HTTP bridge in a separate container instead; the residual (same UID as Nook) is
 * documented.
 */

export type StdioDeclaration = { id: string; name: string; command: string; args: string[]; env: Record<string, string> };

const ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const START_TIMEOUT_MS = 5000;
const RESTART_WINDOW_MS = 10 * 60_000;
const RESTART_CAP = 3;

let declared: StdioDeclaration[] = [];

/** Parses a declaration file's text; throws a message naming what is wrong (never a value). */
export function parseStdioDeclarations(text: string): StdioDeclaration[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("AGENT_MCP_STDIO_FILE is not valid JSON"); }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { servers?: unknown }).servers) ? (parsed as { servers: unknown[] }).servers : null;
  if (!list) throw new Error("AGENT_MCP_STDIO_FILE must hold a JSON array of servers (or { servers: [...] })");
  if (list.length > 20) throw new Error("AGENT_MCP_STDIO_FILE declares more than 20 servers");
  const ids = new Set<string>();
  return list.map((item, index) => {
    const row = item as Record<string, unknown>;
    if (!row || typeof row !== "object") throw new Error(`AGENT_MCP_STDIO_FILE entry ${index + 1} is not an object`);
    const id = typeof row.id === "string" ? row.id : "";
    if (!ID.test(id)) throw new Error(`AGENT_MCP_STDIO_FILE entry ${index + 1}: id must be 1-24 characters of a-z, 0-9, and hyphens`);
    if (ids.has(id)) throw new Error(`AGENT_MCP_STDIO_FILE repeats the id of entry ${index + 1}`);
    ids.add(id);
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 60) : id;
    const command = typeof row.command === "string" ? row.command : "";
    if (!command.startsWith("/")) throw new Error(`AGENT_MCP_STDIO_FILE entry ${id}: command must be an absolute path`);
    const args = Array.isArray(row.args) ? row.args : [];
    if (args.length > 32 || !args.every((arg) => typeof arg === "string" && arg.length <= 1024)) throw new Error(`AGENT_MCP_STDIO_FILE entry ${id}: args must be at most 32 strings`);
    const env: Record<string, string> = {};
    const rawEnv = row.env && typeof row.env === "object" && !Array.isArray(row.env) ? row.env as Record<string, unknown> : {};
    for (const [key, value] of Object.entries(rawEnv)) {
      if (!ENV_NAME.test(key)) throw new Error(`AGENT_MCP_STDIO_FILE entry ${id}: an env name is not a valid variable name`);
      if (typeof value !== "string" || value.length > 4096) throw new Error(`AGENT_MCP_STDIO_FILE entry ${id}: env values must be strings`);
      env[key] = value;
    }
    if (Object.keys(env).length > 32) throw new Error(`AGENT_MCP_STDIO_FILE entry ${id}: at most 32 env variables`);
    return { id, name, command, args: args as string[], env };
  });
}

/** Startup: reads the declarations only with the flag on; logs the count, never a value. */
export function initStdioDeclarations(log: (line: string) => void = (line) => console.log(line)): StdioDeclaration[] {
  declared = [];
  if (!config.agents.stdio || !config.agents.stdioFile) return declared;
  let text: string;
  try {
    text = readFileSync(config.agents.stdioFile, "utf8");
  } catch {
    throw new Error("AGENT_MCP_STDIO_FILE could not be read");
  }
  declared = parseStdioDeclarations(text);
  log(`Agents: AGENT_MCP_STDIO is on; ${declared.length} stdio ${declared.length === 1 ? "server" : "servers"} declared by the host (they run as Nook's user; an HTTP bridge container is the recommended setup).`);
  return declared;
}

export const stdioEnabled = () => config.agents.stdio;
export const declaredStdioServers = (): readonly StdioDeclaration[] => declared;
export const declaredStdioServer = (id: string) => declared.find((entry) => entry.id === id) ?? null;

/** Test hook. */
export function setStdioDeclarationsForTests(list: StdioDeclaration[]) {
  declared = list;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/**
 * One child process speaking newline-delimited JSON-RPC over stdio. Started on first use, with
 * the scrubbed environment; restarted at most 3 times in 10 minutes.
 */
export class McpStdioTransport implements McpTransport {
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private starts: number[] = [];
  private buffer = "";

  constructor(private readonly declaration: StdioDeclaration, private readonly timeoutMs: number) {}

  private async ensureChild() {
    if (this.child && this.child.exitCode === null) return this.child;
    const now = Date.now();
    this.starts = this.starts.filter((at) => now - at < RESTART_WINDOW_MS);
    if (this.starts.length >= RESTART_CAP) throw new McpClientError("NETWORK", "The stdio server restarted too often; it is paused for a while");
    this.starts.push(now);
    const cwd = mkdtempSync(join(tmpdir(), "nook-mcp-"));
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([this.declaration.command, ...this.declaration.args], { cwd, env: { ...this.declaration.env, PATH: "/usr/local/bin:/usr/bin:/bin" }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    } catch {
      throw new McpClientError("NETWORK", "The stdio server could not be started");
    }
    this.child = child;
    this.buffer = "";
    void this.readLoop(child);
    void child.exited.then(() => {
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new McpClientError("NETWORK", "The stdio server exited"));
        this.pending.delete(id);
      }
    });
    // 5 s to start: the first write succeeds once the pipe is open; a child that dies at once fails the first request.
    await Promise.race([new Promise((resolve) => setTimeout(resolve, 20)), child.exited]);
    if (child.exitCode !== null) throw new McpClientError("NETWORK", "The stdio server exited while starting");
    return child;
  }

  private async readLoop(child: ReturnType<typeof Bun.spawn>) {
    const decoder = new TextDecoder();
    const stdout = child.stdout as ReadableStream<Uint8Array>;
    try {
      for await (const chunk of stdout) {
        this.buffer += decoder.decode(chunk, { stream: true });
        if (this.buffer.length > MAX_MESSAGE_BYTES) {
          this.buffer = "";
          child.kill();
          break;
        }
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          newline = this.buffer.indexOf("\n");
          if (line) this.handleLine(line);
        }
      }
    } catch {
      // The child went away; `exited` rejects what is pending.
    }
  }

  private handleLine(line: string) {
    let message: { id?: number | string | null; method?: string; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message.method === "string" && message.id !== undefined && message.id !== null) {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new McpClientError("MCP_PROTOCOL", "The stdio server returned an error"));
    else entry.resolve(message.result);
  }

  private write(message: unknown) {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const stdin = child.stdin as { write: (text: string) => unknown; flush?: () => unknown };
    stdin.write(`${JSON.stringify(message)}\n`);
    stdin.flush?.();
  }

  async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    await this.ensureChild();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpClientError("MCP_TIMEOUT", "The stdio server did not answer in time"));
      }, method === "initialize" ? START_TIMEOUT_MS : this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener("abort", () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new McpClientError("CANCELLED", "The call was cancelled"));
      }, { once: true });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async notify(method: string, params: Record<string, unknown>) {
    await this.ensureChild();
    this.write({ jsonrpc: "2.0", method, params });
  }

  async close() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill();
  }
}
