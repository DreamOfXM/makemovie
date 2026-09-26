import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * 把一句解释挂到任意控件上。规范里原生 title 不算提示（用户看不见、键盘到不了），
 * 所以解释文案一律走这条；提示绑在外层 span 上，禁用态的按钮自身不响应 hover。
 */
export function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}
