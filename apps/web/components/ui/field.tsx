import * as React from 'react'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'

interface FieldProps extends React.ComponentProps<'div'> {
  label: React.ReactNode
  htmlFor?: string
  hint?: React.ReactNode
  error?: React.ReactNode
  required?: boolean
}

function Field({ label, htmlFor, hint, error, required, className, children, ...props }: FieldProps) {
  return (
    <div data-slot="field" className={cn('space-y-1.5', className)} {...props}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {error ? (
        <p data-slot="field-error" className="text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p data-slot="field-hint" className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export { Field }
export type { FieldProps }
