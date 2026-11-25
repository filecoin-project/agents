import { createFileRoute, notFound } from '@tanstack/react-router'
import { DocArticle, pageHead } from '@/components/doc-page'
import { getPageContent } from '@/lib/site/page-content'
import { DOC_PAGES } from '@/lib/site/pages'

export const Route = createFileRoute('/agents/$slug')({
  loader: async ({ params }) => {
    const page = DOC_PAGES.find(
      (candidate) => candidate.path === `/agents/${params.slug}`
    )
    if (!page) {
      throw notFound()
    }
    const { blocks } = await getPageContent({ data: page.slug })
    return { page, blocks }
  },
  head: ({ loaderData }) => (loaderData ? pageHead(loaderData.page) : {}),
  component: AgentsPageRoute,
})

/** A docs page under `/agents`. */
function AgentsPageRoute() {
  const { page, blocks } = Route.useLoaderData()
  return <DocArticle blocks={blocks} page={page} />
}
