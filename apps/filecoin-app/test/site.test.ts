import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  AI_CATALOG_TYPE,
  aiCatalog,
  apiCatalog,
  integrationsJson,
  llmsTxt,
  markdownPath,
  robotsTxt,
  scriptJson,
  serverCardRedirect,
  sitemapXml,
  softwareApplication,
} from '../src/lib/site/discovery.ts'
import {
  renderMarkdown,
  renderMarkdownBlocks,
  slugify,
} from '../src/lib/site/markdown.ts'
import { withMarkdownErrors } from '../src/lib/site/markdown-errors.ts'
import { prefersMarkdown } from '../src/lib/site/negotiate.ts'
import {
  DOC_PAGES,
  findSitePage,
  HOME_PAGE,
  SITE_PAGES,
} from '../src/lib/site/pages.ts'

describe('prefersMarkdown', () => {
  it('serves HTML to browsers', () => {
    assert.equal(
      prefersMarkdown(
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      ),
      false
    )
    assert.equal(prefersMarkdown('*/*'), false)
    assert.equal(prefersMarkdown(null), false)
  })

  it('serves Markdown when the client names it first or alone', () => {
    assert.equal(prefersMarkdown('text/markdown'), true)
    assert.equal(prefersMarkdown('text/markdown, text/html'), true)
    assert.equal(prefersMarkdown('text/markdown, */*;q=0.1'), true)
    assert.equal(prefersMarkdown('text/html;q=0.5, text/markdown'), true)
  })

  it('serves HTML when the client ranks it higher or refuses Markdown', () => {
    assert.equal(prefersMarkdown('text/html, text/markdown;q=0.9'), false)
    assert.equal(prefersMarkdown('text/markdown;q=0'), false)
    assert.equal(prefersMarkdown('text/*, text/markdown;q=0.5'), false)
  })
})

describe('findSitePage', () => {
  it('finds pages by path, .md suffix, and trailing slash', () => {
    assert.deepEqual(findSitePage('/docs/cli'), {
      page: DOC_PAGES[1],
      suffixed: false,
    })
    assert.equal(findSitePage('/docs/cli.md')?.suffixed, true)
    assert.equal(findSitePage('/docs/cli/')?.page.slug, 'cli')
    assert.equal(findSitePage('/agents.md')?.page.slug, 'agents')
  })

  it('maps / and /index.md to the home page', () => {
    assert.equal(findSitePage('/')?.page, HOME_PAGE)
    assert.deepEqual(findSitePage('/index.md'), {
      page: HOME_PAGE,
      suffixed: true,
    })
  })

  it('ignores other paths', () => {
    assert.equal(findSitePage('/mainnet'), undefined)
    assert.equal(findSitePage('/docs/agents'), undefined)
    assert.equal(
      findSitePage('/.well-known/agent-skills/filecoin/SKILL.md'),
      undefined
    )
  })
})

describe('markdownPath', () => {
  it('adds .md, and names the home page index.md', () => {
    assert.equal(markdownPath('/docs/cli'), '/docs/cli.md')
    assert.equal(markdownPath('/'), '/index.md')
  })
})

describe('renderMarkdown', () => {
  it('gives headings unique ids', () => {
    const html = renderMarkdown('# Log in\n\n## `filecoin` setup\n\n## Log in')
    assert.match(html, /<h1 id="log-in">Log in<\/h1>/)
    assert.match(
      html,
      /<h2 id="filecoin-setup"><code>filecoin<\/code> setup<\/h2>/
    )
    assert.match(html, /<h2 id="log-in-1">Log in<\/h2>/)
  })

  it('renders GitHub tables', () => {
    assert.match(
      renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |'),
      /<table>/
    )
  })

  it('slugifies punctuation away', () => {
    assert.equal(slugify('REST API and MCP server'), 'rest-api-and-mcp-server')
    assert.equal(
      slugify("Use filecoin-app's tools!"),
      'use-filecoin-apps-tools'
    )
  })
})

describe('renderMarkdownBlocks', () => {
  const markdown = [
    '# Title',
    '',
    '<!-- tabs -->',
    '',
    '### One',
    '',
    '```sh',
    'filecoin login',
    '```',
    '',
    'Runs `filecoin`.',
    '',
    '### Two',
    '',
    'Text only.',
    '',
    '<!-- /tabs -->',
    '',
    '## After',
  ].join('\n')

  it('turns a tabs block into tabs with code and notes', () => {
    const blocks = renderMarkdownBlocks(markdown)
    assert.deepEqual(
      blocks.map((block) => block.type),
      ['html', 'tabs', 'html']
    )
    const tabs = blocks[1]?.type === 'tabs' ? blocks[1].tabs : []
    assert.deepEqual(
      tabs.map((tab) => tab.label),
      ['One', 'Two']
    )
    assert.deepEqual(tabs[0]?.parts[0], {
      type: 'code',
      lang: 'sh',
      code: 'filecoin login',
    })
    assert.equal(tabs[0]?.parts[1]?.type, 'html')
  })

  it('keeps heading ids unique across blocks', () => {
    const blocks = renderMarkdownBlocks(
      '## A\n\n<!-- tabs -->\n\n### T\n\n## A\n\n<!-- /tabs -->\n\n## A'
    )
    const html = blocks
      .flatMap((block) =>
        block.type === 'html'
          ? [block.html]
          : block.tabs.flatMap((tab) =>
              tab.parts.map((part) => (part.type === 'html' ? part.html : ''))
            )
      )
      .join('')
    assert.match(html, /id="a".*id="a-1".*id="a-2"/s)
  })

  it('rejects an unclosed tabs block', () => {
    assert.throws(() => renderMarkdownBlocks('<!-- tabs -->\n\n### One'))
  })
})

describe('llmsTxt', () => {
  it('lists pages by their Markdown URLs', () => {
    const text = llmsTxt({
      origin: 'https://example.com',
      summary: 'Summary.',
      details: ['A paragraph.', '- A rule.\n- Another rule.'],
      pages: [{ path: '/docs/cli', title: 'CLI', description: 'Commands.' }],
      links: [
        { title: 'Spec', url: 'https://example.com/s', description: 'S.' },
      ],
    })
    assert.match(
      text,
      /^# Filecoin for Agents\n\n> Summary\.\n\nA paragraph\.\n\n- A rule\.\n- Another rule\.\n\n## Docs\n/
    )
    assert.match(
      text,
      /- \[CLI\]\(https:\/\/example\.com\/docs\/cli\.md\): Commands\./
    )
    assert.match(
      text,
      /## Optional\n\n- \[Spec\]\(https:\/\/example\.com\/s\): S\./
    )
  })
})

/** The live site, as the agent skill links to it. */
const SITE_ORIGIN = 'https://poc.filecoin.cloud'

/**
 * Heading ids of a site page, as the rendered page has them.
 *
 * @param slug - Content file name without `.md`.
 */
async function headingIds(slug: string) {
  const markdown = await readFile(
    new URL(`../src/content/${slug}.md`, import.meta.url),
    'utf8'
  )
  const html = renderMarkdown(markdown)
  return new Set([...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]))
}

describe('content links', () => {
  it('point to existing docs pages and headings', async () => {
    const sources = [
      ...SITE_PAGES.map((page) => ({
        name: `${page.slug}.md`,
        url: new URL(`../src/content/${page.slug}.md`, import.meta.url),
        base: page.path,
      })),
      {
        name: 'plugins/filecoin/skills/filecoin/SKILL.md',
        url: new URL(
          '../../../plugins/filecoin/skills/filecoin/SKILL.md',
          import.meta.url
        ),
        base: '/',
      },
    ]
    const broken: string[] = []
    for (const source of sources) {
      const markdown = await readFile(source.url, 'utf8')
      const links = [
        ...markdown.matchAll(/\]\(((?:\/|#)[^)\s]*)\)/g),
        ...markdown.matchAll(
          new RegExp(`${SITE_ORIGIN.replaceAll('.', '\\.')}(/[^\\s)]*)`, 'g')
        ),
      ].map((match) => match[1] ?? '')
      for (const link of links) {
        const [path = '', fragment] = link.split('#')
        const page = findSitePage(path === '' ? source.base : path)?.page
        if (page === undefined) {
          // Only docs pages are checked; app and discovery paths are routes.
          if (path.startsWith('/docs') || path.startsWith('/agents')) {
            broken.push(`${source.name}: ${link}`)
          }
          continue
        }
        if (fragment && !(await headingIds(page.slug)).has(fragment)) {
          broken.push(`${source.name}: ${link}`)
        }
      }
    }
    assert.deepEqual(broken, [])
  })
})

describe('discovery documents', () => {
  it('builds an RFC 9727 linkset for filecoin-api', () => {
    const [entry] = apiCatalog(
      'https://api.example',
      'https://mcp.example'
    ).linkset
    assert.equal(entry?.anchor, 'https://api.example/')
    assert.equal(
      entry?.['service-desc'][0]?.href,
      'https://api.example/openapi.json'
    )
    assert.deepEqual(entry?.item, [{ href: 'https://mcp.example' }])
  })

  it('declares the REST API, MCP server, and CLI for integrations.sh', () => {
    const doc = integrationsJson(
      'https://api.example',
      'https://mcp.example',
      'https://site.example'
    )
    assert.equal(doc.version, 3)
    assert.deepEqual(
      doc.surfaces.map((surface) => [surface.type, surface.auth.status]),
      [
        ['http', 'none'],
        ['mcp', 'none'],
        ['cli', 'required'],
      ]
    )
    for (const surface of doc.surfaces) {
      assert.equal(
        surface.basis.source,
        'https://site.example/.well-known/integrations.json'
      )
    }
    const [api, mcp, cli] = doc.surfaces
    assert.equal(api?.spec, 'https://api.example/openapi.json')
    assert.equal(mcp?.slug, 'filecoin-mcp')
    assert.equal(mcp?.url, 'https://mcp.example')
    assert.equal(cli?.packages?.[0]?.identifier, 'filecoin')
    const used = cli?.auth.entries?.[0]?.use[0]?.id
    assert.ok(used !== undefined && used in doc.credentials)
  })

  it("lists filecoin-api's MCP server card in the AI Catalog", () => {
    const catalog = aiCatalog('https://mcp.example', 'https://site.example')
    assert.equal(AI_CATALOG_TYPE, 'application/ai-catalog+json')
    assert.equal(catalog.specVersion, '1.0')
    assert.equal(catalog.host.displayName, 'Filecoin for Agents')
    assert.deepEqual(catalog.entries, [
      {
        identifier: 'urn:air:filecoin.io:mcp:mcp',
        type: 'application/mcp-server-card+json',
        url: 'https://mcp.example/server-card',
      },
    ])
  })

  it("redirects the site card paths to filecoin-api's card", () => {
    const response = serverCardRedirect('https://mcp.example')
    assert.equal(response.status, 308)
    assert.equal(
      response.headers.get('Location'),
      'https://mcp.example/server-card'
    )
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
  })

  it('lists absolute URLs in the sitemap and links it from robots.txt', () => {
    const xml = sitemapXml('https://site.example', ['/', '/docs/cli?a=1&b=2'])
    assert.match(xml, /<loc>https:\/\/site\.example\/<\/loc>/)
    assert.match(
      xml,
      /<loc>https:\/\/site\.example\/docs\/cli\?a=1&amp;b=2<\/loc>/
    )
    assert.match(
      robotsTxt('https://site.example'),
      /^Sitemap: https:\/\/site\.example\/sitemap\.xml$/m
    )
  })

  it('describes Filecoin for Agents as a SoftwareApplication in script-safe JSON', () => {
    const app = softwareApplication({
      origin: 'https://site.example',
      description: 'Store </script> files.',
      image: 'https://site.example/og.png',
    })
    assert.equal(app['@type'], 'SoftwareApplication')
    assert.equal(app.url, 'https://site.example/')
    const json = scriptJson(app)
    assert.equal(json.includes('</script>'), false)
    assert.deepEqual(JSON.parse(json), app)
  })
})

describe('withMarkdownErrors', () => {
  /**
   * A fake Start handler: 406 unless the request accepts HTML, then the
   * status for the path from `pages`, or 404.
   */
  function fakeStart(pages: Record<string, number>) {
    const seen: string[] = []
    const handler = (request: Request) => {
      const accept = request.headers.get('accept') ?? '*/*'
      seen.push(accept)
      if (!/(^|,)\s*(\*\/\*|text\/html)/.test(accept)) {
        return new Response('{"error":"Only HTML"}', { status: 406 })
      }
      const status = pages[new URL(request.url).pathname] ?? 404
      return new Response('<html></html>', {
        status,
        headers: {
          'Content-Type': 'text/html',
          'X-Frame-Options': 'DENY',
          ...(status === 307 ? { Location: '/docs/quickstart' } : {}),
        },
      })
    }
    return { fetch: withMarkdownErrors(handler), seen }
  }

  const markdown = { headers: { Accept: 'text/markdown' } }

  it('answers a missing page with a Markdown 404', async () => {
    const start = fakeStart({})
    const res = await start.fetch(
      new Request('https://site.example/nope', markdown)
    )
    assert.equal(res.status, 404)
    assert.match(res.headers.get('content-type') ?? '', /^text\/markdown/)
    assert.equal(res.headers.get('x-frame-options'), 'DENY')
    const body = await res.text()
    assert.match(body, /`\/nope`/)
    assert.match(body, /https:\/\/site\.example\/llms\.txt/)
    assert.deepEqual(start.seen, ['text/markdown', 'text/html'])
  })

  it('answers an HTML-only page with a Markdown 406', async () => {
    const start = fakeStart({ '/calibration': 200, '/docs/cli': 200 })
    const res = await start.fetch(
      new Request('https://site.example/calibration', markdown)
    )
    assert.equal(res.status, 406)
    assert.match(await res.text(), /Accept: text\/html/)
    const doc = await start.fetch(
      new Request('https://site.example/docs/cli', {
        headers: { Accept: 'application/json' },
      })
    )
    assert.equal(doc.status, 406)
    assert.match(await doc.text(), /\/docs\/cli\.md/)
  })

  it('passes redirects, HEAD bodies, and other responses through', async () => {
    const start = fakeStart({ '/docs': 307 })
    const redirect = await start.fetch(
      new Request('https://site.example/docs', markdown)
    )
    assert.equal(redirect.status, 307)
    const head = await start.fetch(
      new Request('https://site.example/nope', { ...markdown, method: 'HEAD' })
    )
    assert.equal(head.status, 404)
    assert.equal(await head.text(), '')
    const html = await start.fetch(new Request('https://site.example/nope'))
    assert.equal(html.status, 404)
    assert.match(html.headers.get('content-type') ?? '', /^text\/html/)
  })
})
