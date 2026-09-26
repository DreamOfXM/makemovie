'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

function Table({ className, ...props }: React.ComponentProps<'table'>) {
  const box = React.useRef<HTMLDivElement | null>(null)
  const [more, setMore] = React.useState(false)

  // The narrow-screen question a table asks is "does content continue past the right
  // edge", and nothing else on the page answers it: the scrollbar is hidden and an
  // edge cut mid-column reads as a broken layout. Scroll position is not observable in
  // CSS here (contain/scroll-state does not match in the browsers this ships to), so
  // the container measures itself and publishes data-more for the cue to key off.
  React.useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    el.addEventListener('scroll', measure, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', measure)
    }
  }, [])

  return (
    <div className="relative">
      <div ref={box} data-slot="table-container" data-more={more ? '1' : '0'} className="relative w-full overflow-x-auto">
        <table data-slot="table" className={cn('w-full caption-bottom border-collapse text-sm', className)} {...props} />
      </div>
      <span data-slot="table-more" aria-hidden="true" />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot data-slot="table-footer" className={cn('bg-muted/50 border-t font-medium', className)} {...props} />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'hover:bg-muted/50 data-[state=selected]:bg-muted border-b border-border/70 transition-colors',
        className,
      )}
      {...props}
    />
  )
}

function TableHead({ className, pin, ...props }: React.ComponentProps<'th'> & { pin?: 'left' | 'right' }) {
  return (
    <th
      data-slot="table-head"
      data-pin={pin}
      className={cn(
        'text-muted-foreground h-11 px-3 text-left align-middle text-xs font-medium tracking-wide uppercase whitespace-nowrap',
        'first:pl-6 last:pr-6 [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  )
}

function TableCell({ className, pin, ...props }: React.ComponentProps<'td'> & { pin?: 'left' | 'right' }) {
  return (
    <td
      data-slot="table-cell"
      data-pin={pin}
      className={cn('px-3 py-3 align-middle first:pl-6 last:pr-6 [&:has([role=checkbox])]:pr-0', className)}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return <caption data-slot="table-caption" className={cn('text-muted-foreground mt-4 text-sm', className)} {...props} />
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption }
