import { cn } from 'cn'
import { CopyButton } from '@/components/copy-button'
import { buttonVariants } from '@/components/ui/button'
import type { MarkdownInstallLink } from '@/lib/site/markdown'

/**
 * An `<!-- install -->` block in a docs page: a value to copy, such as the
 * MCP server's URL, and a button for each client that has an install link.
 * The links work without JavaScript.
 *
 * @param props.value - Value to copy.
 * @param props.links - Install links, in source order.
 * @see https://cursor.com/docs/mcp/install-links
 */
export function DocInstall(props: {
  value: string
  links: MarkdownInstallLink[]
}) {
  return (
    <div className="not-prose my-6 flex flex-col gap-3">
      <div className="flex items-center gap-2 rounded-xl border bg-card py-2 pr-2 pl-4">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap">
          {props.value}
        </code>
        <CopyButton label={`Copy ${props.value}`} value={props.value} />
      </div>
      <div className="flex flex-wrap gap-2">
        {props.links.map((link) => (
          <a
            className={cn(buttonVariants({ variant: 'outline' }))}
            href={link.href}
            key={link.href}
          >
            {link.label}
          </a>
        ))}
      </div>
    </div>
  )
}
