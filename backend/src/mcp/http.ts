import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { requireAgentKey, type AppEnv } from "../http";
import { agentOps } from "./ops";
import { registerAllowanceTools, SERVER_INFO, SERVER_INSTRUCTIONS } from "./tools";

// Remote MCP endpoint (D-057): any MCP client connects with just a URL and an agent key,
//   URL:    https://<backend>/mcp
//   header: Authorization: Bearer alw_...
// Stateless Streamable HTTP: every request gets a fresh server bound to the key's agent, so there
// is no session state to share between instances and a revoked key stops working immediately.

export const mcpRoutes = new Hono<AppEnv>()
  .use("*", requireAgentKey)
  // Stateless: no server-to-client event stream to open. Say so instead of hanging an empty stream.
  .get("/", (c) =>
    c.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Use POST with a JSON-RPC body (e.g. tools/list). This server has no GET event stream." }, id: null },
      405,
      { Allow: "POST" },
    ),
  )
  .all("/", async (c) => {
    const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
    registerAllowanceTools(server, agentOps(c.var.agent));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });
