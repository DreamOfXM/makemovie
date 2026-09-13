import * as React from 'react'
import { cn } from '@/lib/utils'

interface PageHeaderProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  breadcrumb?: React.ReactNode
}

function PageHeader({ title, description, actions, breadcrumb, className, ...props }: PageHeaderProps) {
  return (
    <div
      data-slot="page-header"
      className={cn('flex flex-wrap items-start justify-between gap-4', className)}
      {...props}
    >
      <div className="min-w-0 space-y-1.5">
        {breadcrumb && <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{breadcrumb}</div>}
        <h1 className="text-2xl leading-tight font-semibold tracking-tight text-balance">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export { PageHeader }
export type { PageHeaderProps }
