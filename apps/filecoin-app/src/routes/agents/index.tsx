import { createFileRoute } from '@tanstack/react-router'
import { DocArticle, pageHead } from '@/components/doc-page'
import { getPageContent } from '@/lib/site/page-content'
import { AGENTS_PAGE } from '@/lib/site/pages'

export const Route = createFileRoute('/agents/')({
  loader: () => getPageContent({ data: AGENTS_PAGE.slug }),
  head: () => pageHead(AGENTS_PAGE),
  component: AgentsRoute,
})

/** Agents overview: the ways in, cloud and browser agents, and key approval. */
function AgentsRoute() {
  const { blocks } = Route.useLoaderData()
  return <DocArticle blocks={blocks} page={AGENTS_PAGE} />
}
