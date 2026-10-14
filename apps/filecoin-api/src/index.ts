import { createApp } from './app.ts'
import { withMcpHosts } from './mcp-host.ts'

/** Worker entrypoint. */
export default withMcpHosts(createApp())
