import { createFileRoute } from '@tanstack/react-router'
import { serverCardResponse } from '@/lib/site/content.server'

/** An older SEP-2127 draft path, kept for scanners; redirects to filecoin-api's card. */
export const Route = createFileRoute('/.well-known/mcp-server-card')({
  server: {
    handlers: {
      GET: () => serverCardResponse(),
    },
  },
})
