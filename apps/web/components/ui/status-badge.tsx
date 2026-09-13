import * as React from 'react'
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  CircleXIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

type BadgeVariant = React.ComponentProps<typeof Badge>['variant']

const workflowTone: Record<string, { variant: BadgeVariant; icon: React.ElementType }> = {
  draft: { variant: 'muted', icon: CircleDashedIcon },
  ready: { variant: 'info', icon: CircleCheckIcon },
  running: { variant: 'info', icon: LoaderCircleIcon },
  needs_review: { variant: 'warning', icon: TriangleAlertIcon },
  approved: { variant: 'success', icon: CircleCheckIcon },
  blocked: { variant: 'destructive', icon: CircleSlashIcon },
  completed: { variant: 'success', icon: CircleCheckIcon },
  cancelled: { variant: 'outline', icon: CircleXIcon },
}

const probeTone: Record<string, { variant: BadgeVariant; icon: React.ElementType }> = {
  verified: { variant: 'success', icon: CircleCheckIcon },
  failed: { variant: 'destructive', icon: CircleXIcon },
  unverified: { variant: 'muted', icon: CircleDashedIcon },
  probing: { variant: 'info', icon: LoaderCircleIcon },
}

interface StatusBadgeProps extends React.ComponentProps<'span'> {
  status: string
  label: React.ReactNode
}

function StatusBadge({ status, label, className, ...props }: StatusBadgeProps) {
  const tone = workflowTone[status] ?? { variant: 'muted' as BadgeVariant, icon: CircleAlertIcon }
  const Icon = tone.icon
  const spinning = status === 'running'
  return (
    <Badge variant={tone.variant} className={cn('gap-1.5', className)} {...props}>
      <Icon className={cn(spinning && 'animate-spin')} />
      {label}
    </Badge>
  )
}

function ProbeBadge({ status, label, className, ...props }: StatusBadgeProps) {
  const tone = probeTone[status] ?? { variant: 'muted' as BadgeVariant, icon: CircleAlertIcon }
  const Icon = tone.icon
  return (
    <Badge variant={tone.variant} className={cn('gap-1.5', className)} {...props}>
      <Icon className={cn(status === 'probing' && 'animate-spin')} />
      {label}
    </Badge>
  )
}

export { StatusBadge, ProbeBadge, workflowTone, probeTone }
export type { BadgeVariant }
