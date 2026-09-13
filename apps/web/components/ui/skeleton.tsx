import * as React from 'react'
import { cn } from '@/lib/utils'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="skeleton" className={cn('bg-muted animate-pulse rounded-md', className)} {...props} />
}

function TableSkeleton({ rows = 4, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div data-slot="table-skeleton" className="space-y-3 p-6" aria-hidden>
      <Skeleton className="h-8 w-full" />
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="flex items-center gap-4">
          {Array.from({ length: columns }).map((__, column) => (
            <Skeleton key={column} className={cn('h-9 flex-1', column === 0 && 'max-w-56')} />
          ))}
        </div>
      ))}
    </div>
  )
}

export { Skeleton, TableSkeleton }
