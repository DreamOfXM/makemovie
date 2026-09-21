import { CircleHelpIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * 按钮右侧的小问号:悬停/聚焦显示一段解释。控件规范里"异步操作与闸门
 * 必须有可见说明"的标准载体,与 sources-panel 的同名实现保持一致样式。
 */
export function HelpHint({ text, className }: { text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn('text-muted-foreground inline-flex cursor-help', className)}>
          <CircleHelpIcon className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  )
}
