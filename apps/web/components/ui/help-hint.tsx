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
        <span
          tabIndex={0}
          className={cn('text-muted-foreground inline-flex cursor-help', className)}
          // 弹窗打开时 Radix 会把焦点放到第一个可聚焦节点上——往往就是这个问号，
          // 于是悬浮层自己弹在内容上。键盘 Tab 过来时该看还是要看，所以只在
          // 「不是 :focus-visible」的聚焦（脚本/鼠标带来的）上拦下这次展开。
          onFocus={event => {
            if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
          }}
        >
          <CircleHelpIcon className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  )
}
