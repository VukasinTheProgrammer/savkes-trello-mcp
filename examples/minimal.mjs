#!/usr/bin/env node
// The smallest useful MCP server: one tool, stdio, no dependencies.
// Read this first, then server/src/index.mjs — it is this file plus the hard parts.
//
//   printf '%s\n' \
//     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
//     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
//     '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}}}' \
//   | node examples/minimal.mjs

import readline from "node:readline";

const TOOLS = {
  echo: {
    description: "Echo the given text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: ({ text }) => `You said: ${text}`,
  },
};

function handle({ method, params = {} }) {
  if (method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "minimal", version: "1.0.0" },
    };
  }
  if (method === "tools/list") {
    return { tools: Object.entries(TOOLS).map(([name, { run, ...t }]) => ({ name, ...t })) };
  }
  if (method === "tools/call") {
    const tool = TOOLS[params.name];
    // A failing tool is a result the model reads, not a protocol error.
    if (!tool) return { content: [{ type: "text", text: `Unknown tool ${params.name}` }], isError: true };
    return { content: [{ type: "text", text: tool.run(params.arguments ?? {}) }] };
  }
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

// One JSON-RPC message per line. stdout is the protocol, so log to stderr only.
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification: never answered
  let reply;
  try {
    reply = { jsonrpc: "2.0", id: msg.id, result: handle(msg) };
  } catch (err) {
    reply = { jsonrpc: "2.0", id: msg.id, error: { code: err.code ?? -32603, message: err.message } };
  }
  process.stdout.write(JSON.stringify(reply) + "\n");
});
