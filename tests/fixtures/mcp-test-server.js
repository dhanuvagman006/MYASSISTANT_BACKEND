#!/usr/bin/env node
/**
 * A REAL MCP server used by the tests — built with the official SDK and
 * spoken to over genuine stdio JSON-RPC. The MCP tests therefore exercise
 * the actual protocol (handshake, tools/list, tools/call), not a stub.
 *
 * Tools deliberately span the risk classifier:
 *   search_repositories  -> low    (read-only)
 *   create_issue         -> medium (create)
 *   delete_repository    -> high   (destructive)
 *   always_fails         -> tool-level error, to prove failures surface
 */
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const server = new Server(
  { name: "test-github", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "search_repositories",
    description: "Search repositories by keyword",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string", description: "search query" } },
      required: ["q"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, title: { type: "string" } },
      required: ["repo", "title"],
    },
  },
  {
    name: "delete_repository",
    description: "Permanently delete a repository",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    },
  },
  {
    name: "always_fails",
    description: "Returns a tool error, for failure-path testing",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "always_fails") {
    return { content: [{ type: "text", text: "upstream API returned 500" }], isError: true };
  }
  if (name === "search_repositories") {
    return {
      content: [
        { type: "text", text: `Found 2 repositories matching "${args?.q}": ravi-notes, ravi-docs` },
      ],
    };
  }
  if (name === "create_issue") {
    return { content: [{ type: "text", text: `Created issue "${args?.title}" in ${args?.repo}` }] };
  }
  if (name === "delete_repository") {
    return { content: [{ type: "text", text: `Deleted ${args?.repo}` }] };
  }
  return { content: [{ type: "text", text: "unknown tool" }], isError: true };
});

server.connect(new StdioServerTransport());
