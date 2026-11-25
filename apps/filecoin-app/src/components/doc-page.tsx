import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { DocCards } from '@/components/doc-cards'
import { DocInstall } from '@/components/doc-install'
import { DocPrompt } from '@/components/doc-prompt'
import { DocTabs } from '@/components/doc-tabs'
import { SiteShell } from '@/components/site-shell'
import { env } from '@/config/env'
import { markdownPath } from '@/lib/site/discovery'
import type { MarkdownBlock } from '@/lib/site/markdown'
import { DOC_NAV, type SitePage } from '@/lib/site/pages'

const NAV_LINK =
  'block rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground data-[status=active]:bg-muted data-[status=active]:font-medium data-[status=active]:text-foreground'

/**
 * Link to a docs page, active only on that page.
 *
 * @param props.page - Docs page.
 */
function DocLink(props: { page: SitePage }) {
  return (
    <Link
      activeOptions={{ exact: true }}
      className={NAV_LINK}
      to={props.page.path}
    >
      {props.page.title}
    </Link>
  )
}

/**
 * Docs frame: the page list beside the content on wide screens, and above it
 * on narrow ones.
 *
 * @param props.children - Page content.
 */
export function DocsLayout(props: { children: ReactNode }) {
  return (
    <SiteShell>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:flex-row lg:gap-12 lg:px-8 lg:py-12">
        <nav aria-label="Docs" className="lg:w-52 lg:shrink-0">
          <ul className="flex flex-wrap gap-1 lg:sticky lg:top-24 lg:flex-col">
            {DOC_NAV.map((section) => (
              <li className="max-lg:contents" key={section.page.path}>
                <DocLink page={section.page} />
                {section.children.length > 0 && (
                  <ul className="max-lg:contents lg:mt-1 lg:ml-3 lg:flex lg:flex-col lg:gap-1 lg:border-l lg:pl-2">
                    {section.children.map((page) => (
                      <li key={page.path}>
                        <DocLink page={page} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">{props.children}</div>
      </div>
    </SiteShell>
  )
}

/**
 * One block of a docs page.
 *
 * @param props.block - Rendered Markdown block.
 */
function DocBlock(props: { block: MarkdownBlock }) {
  const { block } = props
  switch (block.type) {
    case 'tabs':
      return <DocTabs tabs={block.tabs} />
    case 'install':
      return <DocInstall links={block.links} value={block.value} />
    case 'prompt':
      return <DocPrompt text={block.text} />
    case 'cards':
      return <DocCards cards={block.cards} />
    case 'html':
      return (
        <div
          // The HTML comes from the Markdown files in src/content.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, server-rendered content
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      )
  }
}

/**
 * A docs page rendered from Markdown on the server, with a link to its
 * Markdown version.
 *
 * @param props.page - Docs page.
 * @param props.blocks - Rendered Markdown blocks.
 */
export function DocArticle(props: { page: SitePage; blocks: MarkdownBlock[] }) {
  return (
    <article className="max-w-3xl">
      <div className="prose prose-zinc max-w-none dark:prose-invert prose-headings:scroll-mt-24 prose-headings:font-semibold prose-headings:tracking-tight prose-h1:text-4xl prose-a:text-primary prose-a:underline-offset-4 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:bg-muted prose-pre:text-foreground prose-table:block prose-table:overflow-x-auto prose-th:whitespace-nowrap">
        {props.blocks.map((block, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are static
          <DocBlock block={block} key={index} />
        ))}
      </div>
      <p className="mt-12 border-t pt-6 text-sm text-muted-foreground">
        This page is also available as{' '}
        <a
          className="text-primary underline-offset-4 hover:underline"
          href={markdownPath(props.page.path)}
        >
          Markdown
        </a>
        .
      </p>
    </article>
  )
}

/**
 * Route `head` for a site page: title, description, canonical URL, Open
 * Graph tags, and the Markdown alternate. The root route adds the site-wide
 * Open Graph tags.
 *
 * @param page - Site page.
 * @param title - Document title; defaults to `<page title> · Filecoin for Agents`.
 * @see https://ogp.me
 */
export function pageHead(
  page: SitePage,
  title = `${page.title} · Filecoin for Agents`
) {
  const url = `${env.siteUrl}${page.path}`
  return {
    meta: [
      { title },
      { name: 'description', content: page.description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: page.description },
      { property: 'og:url', content: url },
    ],
    links: [
      { rel: 'canonical', href: url },
      {
        rel: 'alternate',
        type: 'text/markdown',
        href: markdownPath(page.path),
      },
    ],
  }
}
