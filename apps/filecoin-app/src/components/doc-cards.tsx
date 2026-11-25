import type { MarkdownCard } from '@/lib/site/markdown'

/**
 * A `<!-- cards -->` block in a docs page: links as cards, each with what it
 * leads to.
 *
 * @param props.cards - Cards, in source order.
 */
export function DocCards(props: { cards: MarkdownCard[] }) {
  return (
    <ul className="not-prose my-6 grid gap-3 sm:grid-cols-2">
      {props.cards.map((card) => (
        <li key={card.href}>
          <a
            className="flex h-full flex-col gap-1.5 rounded-xl border bg-card p-4 transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/30"
            href={card.href}
          >
            <span className="font-medium">{card.title}</span>
            <span className="text-sm text-pretty text-muted-foreground">
              {card.description}
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}
