import { CheckIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

/** How far a setup step has got. */
export type StepTone = 'done' | 'todo' | 'waiting' | 'problem'

/** Badge tone for each {@link StepTone}. */
const BADGE_TONE: Record<StepTone, StatusTone> = {
  done: 'success',
  todo: 'neutral',
  waiting: 'neutral',
  problem: 'warning',
}

/**
 * One step of the setup rail: a numbered marker that becomes a check once the
 * chain shows the step done, joined to the next step by a line that turns
 * green below a done step, so the page reads how far setup has got. Render
 * steps inside an `<ol>`.
 *
 * @param props.number - Step number.
 * @param props.title - Step title.
 * @param props.description - What the step does.
 * @param props.status - Live status: its tone and label.
 * @param props.children - What the step offers.
 */
export function SetupStep(props: {
  number: number
  title: string
  description: ReactNode
  status: { tone: StepTone; label: ReactNode }
  children?: ReactNode
}) {
  const done = props.status.tone === 'done'
  return (
    <li className="group/step relative flex gap-4 pb-10 last:pb-0">
      <span
        aria-hidden
        className={cn(
          'absolute top-10 bottom-1 left-4 w-0.5 -translate-x-1/2 rounded-full transition-colors duration-500 group-last/step:hidden',
          done ? 'bg-success' : 'bg-border'
        )}
      />
      <span
        aria-hidden
        className={cn(
          'relative flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold tabular-nums transition-colors duration-500',
          done
            ? 'border-success bg-success text-white'
            : 'border-border bg-background'
        )}
      >
        {done ? <CheckIcon className="size-4" strokeWidth={3} /> : props.number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h2 className="text-base font-medium">
            <span className="sr-only">Step {props.number}: </span>
            {props.title}
          </h2>
          <StatusBadge tone={BADGE_TONE[props.status.tone]}>
            {props.status.tone === 'waiting' ? (
              <Spinner className="size-3" />
            ) : null}
            {props.status.label}
          </StatusBadge>
        </div>
        <div className="max-w-prose text-sm text-muted-foreground">
          {props.description}
        </div>
        {props.children ? <div className="mt-3">{props.children}</div> : null}
      </div>
    </li>
  )
}
