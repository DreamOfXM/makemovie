import * as React from 'react'
import { cn } from '@/lib/utils'

function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn('bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-card', className)}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6',
        // Two columns only once the card itself is wide enough. A 1fr track also
        // refuses to shrink below the title's min-content, so without minmax(0,1fr)
        // a long title pushes the action column off the right edge of the page.
        'has-data-[slot=card-action]:@lg/card-header:grid-cols-[minmax(0,1fr)_auto] [.border-b]:pb-6',
        // minmax(0,1fr), never a bare 1fr or an implicit auto track: a grid track
        // refuses to shrink below its content's min-content width, and a truncating
        // line has no break opportunity — one long URL pushed the whole page wider
        // than the screen.
        'grid-cols-[minmax(0,1fr)]',
        className,
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-title" className={cn('text-base leading-none font-semibold tracking-[-0.01em]', className)} {...props} />
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-description" className={cn('text-muted-foreground text-sm', className)} {...props} />
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        // Unconditional col-start-2 would mint an implicit second track even when
        // the header is stacked, so the title column gets max-content width and
        // pushes the actions off the page.
        'self-start @lg/card-header:col-start-2 @lg/card-header:row-span-2 @lg/card-header:row-start-1 @lg/card-header:justify-self-end',
        className,
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-6', className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center gap-3 px-6 [.border-t]:pt-6', className)}
      {...props}
    />
  )
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent }
