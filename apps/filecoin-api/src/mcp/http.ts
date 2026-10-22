import {
  createMcpHandler,
  isLegacyRequest,
  type McpServer,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server'

/**
 * Serve one MCP POST over Streamable HTTP, statelessly, for both protocol
 * eras. A 2025-era request, which carries no per-request `_meta` envelope,
 * gets a transport that answers with plain JSON; the SDK's own 2025-era
 * serving always answers with `text/event-stream`. A 2026-07-28 request goes
 * to `createMcpHandler`. Transport errors keep their JSON-RPC body, which
 * clients that speak both eras read to pick one.
 *
 * @param request - POST to the MCP endpoint.
 * @param factory - Builds a fresh server for this request.
 * @see https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility
 */
export async function handleMcp(
  request: Request,
  factory: () => McpServer
): Promise<Response> {
  if (await isLegacyRequest(request)) {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await factory().connect(transport)
    return await transport.handleRequest(request)
  }
  return await createMcpHandler(factory, { legacy: 'reject' }).fetch(request)
}
