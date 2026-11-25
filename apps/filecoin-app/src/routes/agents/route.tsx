import { createFileRoute, Outlet } from '@tanstack/react-router'
import { DocsLayout } from '@/components/doc-page'

export const Route = createFileRoute('/agents')({
  component: () => (
    <DocsLayout>
      <Outlet />
    </DocsLayout>
  ),
})
