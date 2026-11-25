/**
 * Site pages with a Markdown source in `src/content`. Each one also serves
 * its Markdown at `<path>.md`, or at its own path when the request prefers
 * `text/markdown`.
 */

/** A site page backed by a Markdown file. */
export interface SitePage {
  /** Site path. */
  path: string
  /** File path in `src/content`, without `.md`. */
  slug: string
  /** Page title. */
  title: string
  /** One-sentence description, for `<meta>` and `llms.txt`. */
  description: string
}

/** The landing page's Markdown version. Its HTML is a React page. */
export const HOME_PAGE: SitePage = {
  path: '/',
  slug: 'index',
  title: 'Overview',
  description:
    'Store files and folders on Filecoin from a terminal or an agent, and get links back.',
}

/** Agents overview page, above the pages for each part of agent support. */
export const AGENTS_PAGE: SitePage = {
  path: '/agents',
  slug: 'agents/index',
  title: 'Agents',
  description:
    'The way in for each kind of agent: local, cloud, browser, or chat app with connectors, and how the wallet owner approves its key.',
}

/** First docs page. */
export const START_PAGE: SitePage = {
  path: '/docs/getting-started',
  slug: 'getting-started',
  title: 'Getting started',
  description:
    'Set up your agent with one prompt, or install the filecoin CLI and store a file on the calibration network.',
}

/** A top-level entry of the docs navigation. */
export interface DocSection {
  /** Page the entry links to. */
  page: SitePage
  /** Pages listed under the entry. */
  children: SitePage[]
}

/** Docs navigation, in order. */
export const DOC_NAV: DocSection[] = [
  { page: START_PAGE, children: [] },
  {
    page: {
      path: '/docs/cli',
      slug: 'cli',
      title: 'CLI',
      description:
        'How the filecoin CLI works: log in, check the account, store, retrieve, delete, resume, and read its JSON output.',
    },
    children: [
      {
        path: '/docs/retrieve',
        slug: 'retrieve',
        title: 'Retrieve and verify',
        description:
          'What the PieceCID, the root CID, and each retrieval link check, how to find stored content, and how to store without the CLI.',
      },
    ],
  },
  {
    page: AGENTS_PAGE,
    children: [
      {
        path: '/agents/plugin',
        slug: 'agents/plugin',
        title: 'Agent plugin',
        description:
          'Install the filecoin plugin in Claude Code, Codex, or Cursor. It bundles the agent skill and the MCP server.',
      },
      {
        path: '/agents/skills',
        slug: 'agents/skills',
        title: 'Skills',
        description:
          'Install the agent skill that teaches any agent with a shell when and how to run the filecoin CLI.',
      },
      {
        path: '/agents/mcp',
        slug: 'agents/mcp',
        title: 'MCP',
        description:
          'Add the read-only MCP server to Claude, Cursor, VS Code, Codex, or another agent, and see its tools.',
      },
      {
        path: '/agents/discovery',
        slug: 'agents/discovery',
        title: 'Markdown and agent discovery',
        description:
          'The Markdown version of every docs page, and the files that describe the site to agents.',
      },
    ],
  },
  {
    page: {
      path: '/docs/api',
      slug: 'api',
      title: 'API',
      description:
        'filecoin-api routes, conventions, versioning, retrieval redirects, and rate limits. The OpenAPI document lists the routes.',
    },
    children: [],
  },
  {
    page: {
      path: '/docs/app',
      slug: 'app',
      title: 'Web app',
      description:
        'The explorer, the wallet dashboard, setup links, and the WebMCP tools in filecoin-app.',
    },
    children: [],
  },
]

/** Pages that other pages link to, outside the docs navigation. */
const UNLISTED_PAGES: SitePage[] = [
  {
    path: '/agents/setup',
    slug: 'agents/setup',
    title: 'Agent setup guide',
    description:
      'Steps for an agent to set up filecoin for its user: install, get its key approved, and check the account.',
  },
]

/** Every docs page: the navigation in order, then the unlisted pages. */
export const DOC_PAGES: SitePage[] = [
  ...DOC_NAV.flatMap((section) => [section.page, ...section.children]),
  ...UNLISTED_PAGES,
]

/** Every page with a Markdown version. */
export const SITE_PAGES: SitePage[] = [HOME_PAGE, ...DOC_PAGES]

/** Paths of pages that moved, and where they moved to. */
const MOVED_PAGES: Record<string, string> = {
  '/docs/quickstart': START_PAGE.path,
}

/**
 * Where a moved page's path points now, or undefined when the page has not
 * moved. A `.md` path points to the Markdown version.
 *
 * @param pathname - Request path.
 */
export function movedPath(pathname: string) {
  const suffix = pathname.endsWith('.md') ? '.md' : ''
  const path = pathname
    .slice(0, pathname.length - suffix.length)
    .replace(/\/$/, '')
  const target = Object.hasOwn(MOVED_PAGES, path)
    ? MOVED_PAGES[path]
    : undefined
  return target === undefined ? undefined : `${target}${suffix}`
}

/**
 * Redirect a request for a page that moved, or return `undefined`. The
 * redirect allows any origin, as the Markdown it leads to does: a browser
 * checks every response of a cross-origin fetch, redirects included.
 *
 * @param url - Request URL.
 * @see https://www.rfc-editor.org/rfc/rfc9110#name-308-permanent-redirect
 * @see https://fetch.spec.whatwg.org/#http-cors-protocol
 */
export function movedResponse(url: URL) {
  const target = movedPath(url.pathname)
  return target === undefined
    ? undefined
    : new Response(null, {
        status: 308,
        headers: {
          Location: `${target}${url.search}`,
          'Access-Control-Allow-Origin': '*',
        },
      })
}

/**
 * Find the page that serves a path, as HTML or as Markdown. A trailing
 * slash and a `.md` suffix both resolve to the page.
 *
 * @param pathname - Request path.
 * @returns The page, and whether the path asked for Markdown by suffix.
 */
export function findSitePage(pathname: string) {
  const suffixed = pathname.endsWith('.md')
  let path = suffixed ? pathname.slice(0, -'.md'.length) : pathname
  if (path === '/index') {
    path = '/'
  }
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1)
  }
  const page = SITE_PAGES.find((candidate) => candidate.path === path)
  return page ? { page, suffixed } : undefined
}
