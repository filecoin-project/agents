import { createFileRoute } from '@tanstack/react-router'
import { aiCatalogResponse } from '@/lib/site/content.server'

/** The AI Catalog, which lists filecoin-api's MCP server card. */
export const Route = createFileRoute('/.well-known/ai-catalog.json')({
  server: {
    handlers: {
      GET: ({ request }) => aiCatalogResponse(request),
      HEAD: ({ request }) => aiCatalogResponse(request),
    },
  },
})
