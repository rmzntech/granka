// Minimal MCP client over stdio: spawn a server, speak JSON-RPC 2.0 line by
// line, list its tools and call them. No SDK dependency — the protocol for
// initialize/tools.list/tools.call is small and stable.
import { spawn } from "node:child_process";
import readline from "node:readline";

const REQUEST_TIMEOUT = 30000;

export class McpClient {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.tools = null;
  }

  async connect() {
    if (this.child) return;
    const { command, args = [], env = {} } = this.spec;
    if (!command) throw new Error(`MCP ${this.name}: не указана команда`);
    this.child = spawn(String(command), args.map(String), {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (err) => {
      console.error(`[granka mcp ${this.name}]`, err?.message ?? err);
      this.rejectAll(err);
      this.child = null;
    });
    this.child.on("exit", () => {
      this.child = null;
      this.tools = null;
      this.rejectAll(new Error(`MCP ${this.name}: процесс завершился`));
    });
    this.child.stderr.on("data", (chunk) => {
      console.error(`[granka mcp ${this.name}]`, String(chunk).trim().slice(0, 300));
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.onMessage(line));
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "granka", version: "0.5" },
    });
    this.notify("notifications/initialized", {});
  }

  onMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message.id || !this.pending.has(message.id)) return;
    const { resolve, reject } = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) reject(new Error(String(message.error.message ?? "MCP error")));
    else resolve(message.result);
  }

  rejectAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error(`MCP ${this.name}: не подключён`));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}: таймаут ${method}`));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async listTools() {
    await this.connect();
    if (this.tools) return this.tools;
    const result = await this.request("tools/list", {});
    this.tools = Array.isArray(result?.tools) ? result.tools : [];
    return this.tools;
  }

  async callTool(toolName, args) {
    await this.connect();
    const result = await this.request("tools/call", { name: toolName, arguments: args ?? {} });
    if (result?.isError) {
      const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
      throw new Error(text || "MCP tool error");
    }
    const text = (result.content ?? [])
      .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
      .join("\n");
    return text || "(пусто)";
  }

  close() {
    try { this.child?.kill(); } catch (err) { console.error("[granka mcp]", err?.message ?? err); }
    this.child = null;
  }
}

const clients = new Map();

export function mcpClients(servers) {
  const wanted = servers && typeof servers === "object" ? servers : {};
  for (const [name, client] of clients) {
    if (!wanted[name]) {
      client.close();
      clients.delete(name);
    }
  }
  const result = new Map();
  for (const [name, spec] of Object.entries(wanted)) {
    if (!spec || typeof spec !== "object" || !spec.command) continue;
    if (!clients.has(name)) clients.set(name, new McpClient(name, spec));
    result.set(name, clients.get(name));
  }
  return result;
}

// Wrap every MCP tool as a granka custom tool: mcp_<server>_<tool>.
// --- schema cache ---------------------------------------------------------
// Tool names/descriptions are cached on disk (~/.granka/mcp-tools.json) so a
// new session can register thin proxies WITHOUT spawning any server. Servers
// start lazily on the first real call or mcp_search — never at session start.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_FILE = path.join(os.homedir(), ".granka", "mcp-tools.json");

export function readMcpCache() {
  return readCache();
}

export async function refreshMcpCache(servers, names = null) {
  const cache = readCache();
  const clients = mcpClients(servers);
  for (const name of names ?? Object.keys(clients)) {
    const client = clients.get(name);
    if (!client) continue;
    try {
      cache[name] = await client.listTools();
    } catch (err) {
      console.error(`[granka mcp ${name}] refresh:`, err?.message ?? err);
    }
  }
  writeCache(cache);
  return cache;
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");
  } catch (err) {
    console.error("[granka mcp cache]", err?.message ?? err);
  }
}

// Full schemas for every known server tool (spawns servers that have no
// cache entry yet and refreshes the ones asked for).
async function ensureSchemas(servers, onlyName = null, force = false) {
  const cache = readCache();
  const clients = mcpClients(servers);
  for (const [name, client] of clients) {
    if (onlyName && name !== onlyName) continue;
    if (!force && cache[name]?.length) continue;
    try {
      cache[name] = await client.listTools();
    } catch (err) {
      console.error(`[granka mcp ${name}] listTools:`, err?.message ?? err);
    }
  }
  writeCache(cache);
  return cache;
}

// Thin proxies registered at session start: name + one-line description only.
// The full input schema is NOT in the context until mcp_search returns it.
function proxyTool(serverName, client, tool) {
  const oneLine = String(tool.description ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
  return {
    name: `mcp_${serverName}_${tool.name}`,
    label: `MCP: ${tool.name}`,
    description: `MCP ${serverName}/${tool.name}${oneLine ? `: ${oneLine}` : ""}. Аргументы: вызови mcp_search для полной схемы.`,
    promptSnippet: `mcp_${serverName}_${tool.name}: MCP ${serverName}`,
    parameters: { type: "object", properties: {} },
    execute: async (_id, params) => {
      const text = await client.callTool(tool.name, params);
      return { content: [{ type: "text", text }], details: { server: serverName } };
    },
  };
}

export async function mcpTools(servers) {
  const cache = readCache();
  return mcpProxyTools(servers, cache);
}

// Search over cached schemas; spans servers without spawning the ones that
// are already cached, and spawns (once) the ones that are not.
export function mcpSearchTool(servers) {
  return {
    name: "mcp_search",
    label: "Поиск MCP-инструментов",
    description:
      "Ищет инструменты подключённых MCP-серверов по запросу и возвращает их полные схемы (имена, описания, параметры). " +
      "Сначала вызови mcp_search, затем вызывай найденный инструмент mcp_<сервер>_<инструмент> с его параметрами. " +
      "Серверы запускаются лениво при первом обращении.",
    promptSnippet: "mcp_search: найти MCP-инструмент по запросу",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Что нужно сделать, например: прочитать файл, выполнить SQL" },
        server: { type: "string", description: "Имя сервера (необязательно)" },
        refresh: { type: "boolean", description: "Перечитать список инструментов сервера заново" },
      },
      required: ["query"],
    },
    execute: async (_id, params) => {
      const query = String(params.query ?? "").toLowerCase();
      const cache = params.refresh
        ? await ensureSchemas(servers, params.server || null)
        : readCache();
      const missing = Object.entries(mcpClients(servers)).filter(([name]) => !cache[name]?.length);
      if (missing.length && !params.refresh) {
        for (const [name, client] of missing) {
          try {
            cache[name] = await client.listTools();
          } catch (err) {
            console.error(`[granka mcp ${name}] search:`, err?.message ?? err);
          }
        }
        writeCache(cache);
      }
      const hits = [];
      for (const [serverName, tools] of Object.entries(cache)) {
        if (params.server && serverName !== params.server) continue;
        for (const tool of tools) {
          const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
          if (!query || haystack.includes(query)) hits.push({ serverName, tool });
        }
      }
      if (!hits.length) {
        const known = Object.keys(cache);
        return {
          content: [{ type: "text", text: `Ничего не найдено. Серверы: ${known.join(", ") || "нет"}` }],
          details: {},
        };
      }
      const text = hits
        .slice(0, 8)
        .map(
          ({ serverName, tool }) =>
            `### mcp_${serverName}_${tool.name}\n${tool.description ?? ""}\n${JSON.stringify(tool.inputSchema ?? {}, null, 2)}`,
        )
        .join("\n\n");
      return { content: [{ type: "text", text }], details: { hits: hits.length } };
    },
  };
}

export function mcpProxyTools(servers, cache) {
  const tools = [];
  const clients = mcpClients(servers);
  for (const [serverName, client] of clients) {
    for (const tool of cache[serverName] ?? []) {
      tools.push(proxyTool(serverName, client, tool));
    }
  }
  return tools;
}
