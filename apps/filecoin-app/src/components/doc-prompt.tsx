import { CheckIcon, CopyIcon, SparklesIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * A `<!-- prompt -->` block in a docs page: a prompt to paste into an agent,
 * with a button that copies it.
 *
 * @param props.text - Prompt to copy.
 */
export function DocPrompt(props: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <figure className="not-prose my-6 overflow-hidden rounded-xl border bg-card">
      <figcaption className="flex items-center gap-2 border-b py-2 pr-2 pl-4 text-sm text-muted-foreground">
        <SparklesIcon aria-hidden className="size-4" />
        <span>Agent prompt</span>
        <Button
          className="ml-auto"
          onClick={async () => {
            await navigator.clipboard.writeText(props.text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          size="sm"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy prompt'}
        </Button>
      </figcaption>
      <p className="px-4 py-4 text-pretty wrap-break-word sm:px-5">
        {props.text}
      </p>
    </figure>
  )
}
