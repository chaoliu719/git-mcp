import type { NextApiRequest, NextApiResponse } from "next";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerTools } from "./tools/index.js";
import {
  storeSession,
  sessionExists,
  queueMessage,
  getPendingMessages,
} from "./utils/sessionStore.js";
import { parseRawBody } from "./utils/bodyParser.js";

// For local instances only - doesn't work across serverless invocations
let activeTransports: { [sessionId: string]: SSEServerTransport } = {};

function flushResponse(res: NextApiResponse) {
  const maybeFlush = (res as any).flush;
  if (typeof maybeFlush === "function") {
    maybeFlush.call(res);
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const adjustedUrl = new URL(req.url || "", `http://${req.headers.host}`);

  if (req.method === "GET") {
    try {
      // Instantiate the MCP server.
      const mcp = new McpServer({ name: "MCP SSE Server", version: "1.0.0" });

      if (!req.headers.host) {
        throw new Error("Missing host header");
      }

      // Register the "fetch_documentation" tool.
      registerTools(mcp, req.headers.host, req.url);

      // Create an SSE transport.
      const endpoint = "/api/mcp/message";
      const transport = new SSEServerTransport(endpoint, res);

      // Connect the MCP server using the transport.
      await mcp.connect(transport);

      const sessionId = transport.sessionId;

      // Store in local map (for same-instance handling)
      activeTransports[sessionId] = transport;

      // Store in Redis (for cross-instance handling)
      await storeSession(sessionId, {
        host: req.headers.host,
        userAgent: req.headers["user-agent"],
        createdAt: new Date().toISOString(),
      });

      // Send handshake message
      await transport.send({
        jsonrpc: "2.0",
        id: sessionId,
        result: { message: "SSE Connected", sessionId },
      });
      flushResponse(res);
      console.log(`SSE connection established, sessionId: ${sessionId}`);

      // Check for any pending messages that might have arrived before this connection
      const pendingMessages = await getPendingMessages(sessionId);
      if (pendingMessages.length > 0) {
        console.log(
          `Processing ${pendingMessages.length} pending messages for session ${sessionId}`
        );
        for (const msgData of pendingMessages) {
          try {
            await transport.send(msgData.payload);
            flushResponse(res);
          } catch (error) {
            console.error(`Error sending pending message: ${error}`);
          }
        }
      }

      // Set up polling for new messages (only needed if SSE doesn't auto-receive)
      const pollInterval = setInterval(async () => {
        try {
          const messages = await getPendingMessages(sessionId);
          for (const msgData of messages) {
            await transport.send(msgData.payload);
            flushResponse(res);
          }
        } catch (error) {
          console.error("Error polling for messages:", error);
        }
      }, 2000); // Poll every 2 seconds

      // Clean up when the connection closes
      req.on("close", async () => {
        clearInterval(pollInterval);
        delete activeTransports[sessionId];
        // await removeSession(sessionId);
        console.log(`SSE connection closed, sessionId: ${sessionId}`);
      });
    } catch (error) {
      console.error("MCP SSE Server error:", error);
      res.write(
        `data: ${JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })}\n\n`
      );
      res.end();
    }
    return;
  }

  // POST /api/mcp/message?sessionId=...: handle incoming messages.
  if (req.method === "POST" && adjustedUrl.pathname.endsWith("/message")) {
    const sessionId = adjustedUrl.searchParams.get("sessionId");

    if (!sessionId) {
      res.status(400).json({ error: "Missing sessionId parameter" });
      return;
    }

    try {
      // Check if we have the transport in this instance
      if (activeTransports[sessionId]) {
        // We can handle it directly in this instance
        await activeTransports[sessionId].handlePostMessage(req, res);
      }

      const sessionValid = await sessionExists(sessionId);

      if (!sessionValid) {
        res
          .status(400)
          .json({ error: "No active SSE session for the provided sessionId" });
        return;
      }

      const rawBody = await parseRawBody(req);
      const message = JSON.parse(rawBody.toString("utf8"));

      // Queue the message in Redis for the SSE connection to pick up
      await queueMessage(sessionId, message);

      // Respond with success
      res.status(200).json({ success: true, queued: true });
    } catch (error) {
      console.error("Error handling POST message:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  res.status(404).end("Not found");
}
