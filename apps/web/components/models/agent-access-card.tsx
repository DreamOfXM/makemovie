'use client'

import { useCallback, useEffect, useState } from 'react'
import { BotIcon, CopyIcon, PlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, API_BASE, getToken } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/api-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

interface AgentTokenRow {
  id: string
  name: string
  role: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

/** Agent 接入:签发令牌 + MCP 端点,30 秒把 makemovie 挂进 Claude Code/Cursor 的工具箱。 */
export function AgentAccessCard() {
  const { t } = useI18n()
  const [tokens, setTokens] = useState<AgentTokenRow[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const endpoint = typeof window === 'undefined' ? '/mcp' : `${window.location.origin}/mcp`

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/agent-tokens`, { headers: { authorization: `Bearer ${getToken()}` } })
      if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status)
      setTokens((await response.json() as { tokens: AgentTokenRow[] }).tokens)
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    }
  }, [t])

  useEffect(() => { void load() }, [load])

  async function create() {
    if (name.trim() === '') return
    setBusy(true)
    try {
      const response = await fetch(`${API_BASE}/agent-tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status)
      const body = await response.json() as { secret: string }
      setSecret(body.secret)
      setName('')
      await load()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    try {
      const response = await fetch(`${API_BASE}/agent-tokens/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${getToken()}` } })
      if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status)
      await load()
    } catch (error) {
      toast.error(apiErrorMessage(error, t))
    }
  }

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text)
    toast.success(t('common.copied'))
  }

  const claudeConfig = JSON.stringify({ mcpServers: { makemovie: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${secret ?? '<token>'}` } } } }, null, 2)
  const curlExample = `curl -s -X POST ${endpoint} \\\n  -H "Authorization: Bearer ${secret ?? '<token>'}" \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BotIcon className="text-muted-foreground size-4" />
          {t('models.agent.title')}
        </CardTitle>
        <CardDescription>{t('models.agent.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="text-muted-foreground text-xs">{t('models.agent.endpoint')}</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="bg-muted rounded px-2 py-1 text-sm">{endpoint}</code>
            <Button variant="ghost" size="sm" onClick={() => copy(endpoint)}><CopyIcon /></Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Input value={name} onChange={event => setName(event.target.value)} placeholder={t('models.agent.namePlaceholder')} className="max-w-64" />
          <Button size="sm" disabled={busy || name.trim() === ''} onClick={() => void create()}>
            <PlusIcon />
            {t('models.agent.create')}
          </Button>
        </div>

        {secret && (
          <div className="rounded-md border border-warning/50 bg-warning/5 p-3 text-sm">
            <div className="font-medium">{t('models.agent.secretShown')}</div>
            <div className="text-muted-foreground mt-1 text-xs">{t('models.agent.secretHint')}</div>
            <div className="mt-2 flex items-center gap-2">
              <code className="bg-muted flex-1 truncate rounded px-2 py-1 font-mono text-xs">{secret}</code>
              <Button variant="ghost" size="sm" onClick={() => copy(secret)}><CopyIcon /></Button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {tokens.length === 0 ? (
            <div className="text-muted-foreground text-sm">{t('models.agent.noTokens')}</div>
          ) : tokens.map(token => (
            <div key={token.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{token.name}</span>
                <Badge variant="outline" className="ml-2">{token.role}</Badge>
                {token.revokedAt && <Badge variant="destructive" className="ml-2">{t('models.agent.revoked')}</Badge>}
                {token.lastUsedAt && <span className="text-muted-foreground ml-2 text-xs">{t('models.agent.lastUsed')}: {new Date(token.lastUsedAt).toLocaleString()}</span>}
              </div>
              {!token.revokedAt && (
                <Button variant="ghost" size="sm" onClick={() => void revoke(token.id)}>{t('models.agent.revoke')}</Button>
              )}
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <div className="text-muted-foreground text-xs">{t('models.agent.claudeConfig')}</div>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">{claudeConfig}</pre>
          <div className="text-muted-foreground text-xs">{t('models.agent.curlExample')}</div>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">{curlExample}</pre>
        </div>
      </CardContent>
    </Card>
  )
}
