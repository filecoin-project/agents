import { Marked, type Token, type Tokens } from 'marked'

/**
 * Turn heading text into a URL fragment: lowercase, letters, digits and
 * hyphens only.
 *
 * @param text - Heading text without Markdown.
 */
export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

/**
 * A marked instance whose headings get unique `id` attributes, so links such
 * as `/docs/cli#log-in` work. Ids stay unique across every parse call on the
 * same instance.
 *
 * @see https://marked.js.org/using_pro#renderer
 */
function createMarked() {
  const seen = new Map<string, number>()
  return new Marked({
    gfm: true,
    renderer: {
      heading(
        this: { parser: { parseInline(tokens: Tokens.Generic[]): string } },
        token: Tokens.Heading
      ) {
        const base = slugify(token.text) || 'section'
        const count = seen.get(base) ?? 0
        seen.set(base, count + 1)
        const id = count === 0 ? base : `${base}-${count}`
        const html = this.parser.parseInline(token.tokens)
        return `<h${token.depth} id="${id}">${html}</h${token.depth}>\n`
      },
    },
  })
}

/**
 * Render a site page's Markdown to HTML. Headings get `id` attributes, so
 * links such as `/docs/cli#log-in` work.
 *
 * @param markdown - Page Markdown.
 * @see https://marked.js.org/using_pro#renderer
 */
export function renderMarkdown(markdown: string) {
  return createMarked().parse(markdown, { async: false })
}

/** A piece of a tab: rendered Markdown, or a code block to show as a terminal. */
export type MarkdownTabPart =
  | { type: 'html'; html: string }
  | { type: 'code'; lang: string; code: string }

/** One tab of a tabs block: the `###` heading text and what follows it. */
export interface MarkdownTab {
  /** Heading text, as plain text. */
  label: string
  /** Tab content in source order. */
  parts: MarkdownTabPart[]
}

/** A link of an install block, to show as a button. */
export interface MarkdownInstallLink {
  /** Link text, as plain text. */
  label: string
  /** Link target, which may use an app's own scheme such as `cursor:`. */
  href: string
}

/** A card of a cards block: a link and what it leads to. */
export interface MarkdownCard {
  /** Link text, as plain text. */
  title: string
  /** Link target. */
  href: string
  /** Text after the link, as plain text. */
  description: string
}

/**
 * A piece of a page: rendered Markdown, a set of tabs, an install block, a
 * prompt to copy, or a set of cards.
 */
export type MarkdownBlock =
  | { type: 'html'; html: string }
  | { type: 'tabs'; tabs: MarkdownTab[] }
  | { type: 'install'; value: string; links: MarkdownInstallLink[] }
  | { type: 'prompt'; text: string }
  | { type: 'cards'; cards: MarkdownCard[] }

/** Comments that open and close a tabs block in a content file. */
const TABS_OPEN = '<!-- tabs -->'
const TABS_CLOSE = '<!-- /tabs -->'

/**
 * Whether a token is the given marker comment on its own.
 *
 * @param token - Block token.
 * @param marker - Comment to match.
 */
function isMarker(token: Token, marker: string) {
  return token.type === 'html' && token.raw.trim() === marker
}

/**
 * Read an install block: one code block with the value to copy, and one list
 * whose items are links.
 *
 * @param marked - Marked instance, to walk the list's tokens.
 * @param tokens - Tokens between the install comments.
 */
function parseInstall(marked: Marked, tokens: Token[]): MarkdownBlock {
  const [code, list, ...rest] = tokens.filter((token) => token.type !== 'space')
  if (code?.type !== 'code' || list?.type !== 'list' || rest.length > 0) {
    throw new Error('An install block takes one code block and one list')
  }
  const links: MarkdownInstallLink[] = []
  marked.walkTokens([list], (token) => {
    if (token.type === 'link') {
      links.push({ label: token.text, href: token.href })
    }
  })
  return { type: 'install', value: code.text, links }
}

/**
 * Read a prompt block: one code block with the prompt to copy.
 *
 * @param tokens - Tokens between the prompt comments.
 */
function parsePrompt(tokens: Token[]): MarkdownBlock {
  const [code, ...rest] = tokens.filter((token) => token.type !== 'space')
  if (code?.type !== 'code' || rest.length > 0) {
    throw new Error('A prompt block takes one code block')
  }
  return { type: 'prompt', text: code.text }
}

/**
 * Read a cards block: one list whose items are a link, a colon, and a
 * description.
 *
 * @param tokens - Tokens between the cards comments.
 */
function parseCards(tokens: Token[]): MarkdownBlock {
  const [list, ...rest] = tokens.filter((token) => token.type !== 'space')
  if (list?.type !== 'list' || rest.length > 0) {
    throw new Error('A cards block takes one list')
  }
  const cards = (list as Tokens.List).items.map((item) => {
    const [link, text, ...others] = item.tokens.flatMap((token) =>
      'tokens' in token ? (token.tokens ?? []) : []
    )
    if (
      link?.type !== 'link' ||
      text?.type !== 'text' ||
      others.length > 0 ||
      !text.raw.startsWith(': ')
    ) {
      throw new Error(`Not a card: ${item.raw.trim()}`)
    }
    return {
      title: link.text,
      href: link.href,
      description: text.raw.slice(': '.length),
    }
  })
  return { type: 'cards', cards }
}

/** Readers of the blocks that hold no Markdown of their own, by comment name. */
const BLOCK_PARSERS = {
  install: parseInstall,
  prompt: (_marked: Marked, tokens: Token[]) => parsePrompt(tokens),
  cards: (_marked: Marked, tokens: Token[]) => parseCards(tokens),
}

/** Name of a block in {@link BLOCK_PARSERS}. */
type BlockName = keyof typeof BLOCK_PARSERS

/** Block names, for matching opening comments. */
const BLOCK_NAMES = Object.keys(BLOCK_PARSERS) as BlockName[]

/**
 * Render a site page's Markdown to blocks, so the page can show some of it
 * as components. Between `<!-- tabs -->` and `<!-- /tabs -->`, each `###`
 * heading starts a tab, and code blocks stay as source for a terminal with a
 * copy button. Other comment pairs frame one block each:
 *
 * - `install`: a code block with a value to copy, and a list of links to show
 *   as buttons.
 * - `prompt`: a code block with a prompt to copy into an agent.
 * - `cards`: a list of links to show as cards.
 *
 * The Markdown version keeps the source, so it reads the same without them.
 *
 * @param markdown - Page Markdown.
 */
export function renderMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const marked = createMarked()
  const blocks: MarkdownBlock[] = []
  let pending: Token[] = []
  let tabs: MarkdownTab[] | undefined
  let open: { name: BlockName; tokens: Token[] } | undefined

  /** Render the pending tokens into the current tab or the page. */
  const flush = () => {
    if (pending.length === 0) {
      return
    }
    const html = marked.parser(pending)
    pending = []
    if (html.trim() === '') {
      return
    }
    if (tabs === undefined) {
      blocks.push({ type: 'html', html })
    } else {
      tabs.at(-1)?.parts.push({ type: 'html', html })
    }
  }

  for (const token of marked.lexer(markdown)) {
    const opened = BLOCK_NAMES.find((name) =>
      isMarker(token, `<!-- ${name} -->`)
    )
    if (open !== undefined) {
      if (isMarker(token, `<!-- /${open.name} -->`)) {
        blocks.push(BLOCK_PARSERS[open.name](marked, open.tokens))
        open = undefined
      } else {
        open.tokens.push(token)
      }
    } else if (tabs === undefined && opened !== undefined) {
      flush()
      open = { name: opened, tokens: [] }
    } else if (tabs === undefined && isMarker(token, TABS_OPEN)) {
      flush()
      tabs = []
    } else if (tabs !== undefined && isMarker(token, TABS_CLOSE)) {
      flush()
      blocks.push({ type: 'tabs', tabs })
      tabs = undefined
    } else if (
      tabs !== undefined &&
      token.type === 'heading' &&
      token.depth === 3
    ) {
      flush()
      tabs.push({ label: token.text.replaceAll('`', ''), parts: [] })
    } else if (tabs !== undefined && token.type === 'code') {
      flush()
      tabs
        .at(-1)
        ?.parts.push({ type: 'code', lang: token.lang ?? '', code: token.text })
    } else if (tabs === undefined || tabs.length > 0) {
      pending.push(token)
    } else if (token.type !== 'space') {
      throw new Error(`Content before the first tab: ${token.raw.trim()}`)
    }
  }
  if (tabs !== undefined) {
    throw new Error(`Missing ${TABS_CLOSE}`)
  }
  if (open !== undefined) {
    throw new Error(`Missing <!-- /${open.name} -->`)
  }
  flush()
  return blocks
}
