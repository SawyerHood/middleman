import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Loader2,
  Plug,
  Save,
  TestTube2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import type {
  SlackSettingsConfig,
  SlackDraft,
  SlackChannelDescriptor,
  TelegramSettingsConfig,
  TelegramDraft,
} from './settings-types'
import {
  fetchSlackSettings,
  updateSlackSettings,
  disableSlackSettings,
  testSlackConnection,
  fetchSlackChannels,
  fetchTelegramSettings,
  updateTelegramSettings,
  disableTelegramSettings,
  testTelegramConnection,
  toErrorMessage,
} from './settings-api'
import type { AgentDescriptor, SlackStatusEvent, TelegramStatusEvent } from '@middleman/protocol'

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function toSlackDraft(config: SlackSettingsConfig): SlackDraft {
  return {
    enabled: config.enabled,
    appToken: '',
    botToken: '',
    listenDm: config.listen.dm,
    channelIds: [...config.listen.channelIds],
    includePrivateChannels: config.listen.includePrivateChannels,
    respondInThread: config.response.respondInThread,
    replyBroadcast: config.response.replyBroadcast,
    maxFileBytes: String(config.attachments.maxFileBytes),
    allowImages: config.attachments.allowImages,
    allowText: config.attachments.allowText,
    allowBinary: config.attachments.allowBinary,
  }
}

function buildSlackPatch(draft: SlackDraft): Record<string, unknown> {
  const maxFileBytes = Number.parseInt(draft.maxFileBytes, 10)
  const patch: Record<string, unknown> = {
    enabled: draft.enabled,
    listen: {
      dm: draft.listenDm,
      channelIds: [...new Set(draft.channelIds.map((id) => id.trim()).filter(Boolean))],
      includePrivateChannels: draft.includePrivateChannels,
    },
    response: {
      respondInThread: draft.respondInThread,
      replyBroadcast: draft.replyBroadcast,
    },
    attachments: {
      maxFileBytes: Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : 10 * 1024 * 1024,
      allowImages: draft.allowImages,
      allowText: draft.allowText,
      allowBinary: draft.allowBinary,
    },
  }
  if (draft.appToken.trim()) patch.appToken = draft.appToken.trim()
  if (draft.botToken.trim()) patch.botToken = draft.botToken.trim()
  return patch
}

function toTelegramDraft(config: TelegramSettingsConfig): TelegramDraft {
  return {
    enabled: config.enabled,
    botToken: '',
    allowedUserIds: Array.isArray(config.allowedUserIds) ? [...config.allowedUserIds] : [],
    timeoutSeconds: String(config.polling.timeoutSeconds),
    limit: String(config.polling.limit),
    dropPendingUpdatesOnStart: config.polling.dropPendingUpdatesOnStart,
    disableLinkPreview: config.delivery.disableLinkPreview,
    replyToInboundMessageByDefault: config.delivery.replyToInboundMessageByDefault,
    maxFileBytes: String(config.attachments.maxFileBytes),
    allowImages: config.attachments.allowImages,
    allowText: config.attachments.allowText,
    allowBinary: config.attachments.allowBinary,
  }
}

function buildTelegramPatch(draft: TelegramDraft): Record<string, unknown> {
  const timeoutSeconds = Number.parseInt(draft.timeoutSeconds, 10)
  const limit = Number.parseInt(draft.limit, 10)
  const maxFileBytes = Number.parseInt(draft.maxFileBytes, 10)
  const patch: Record<string, unknown> = {
    enabled: draft.enabled,
    allowedUserIds: draft.allowedUserIds,
    polling: {
      timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : 25,
      limit: Number.isFinite(limit) ? limit : 100,
      dropPendingUpdatesOnStart: draft.dropPendingUpdatesOnStart,
    },
    delivery: {
      parseMode: 'HTML',
      disableLinkPreview: draft.disableLinkPreview,
      replyToInboundMessageByDefault: draft.replyToInboundMessageByDefault,
    },
    attachments: {
      maxFileBytes: Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : 10 * 1024 * 1024,
      allowImages: draft.allowImages,
      allowText: draft.allowText,
      allowBinary: draft.allowBinary,
    },
  }
  if (draft.botToken.trim()) patch.botToken = draft.botToken.trim()
  return patch
}

function parseCommaSeparated(value: string): string[] {
  return value.split(',').map((e) => e.trim()).filter((e) => e.length > 0)
}

/* ------------------------------------------------------------------ */
/*  Badge components                                                  */
/* ------------------------------------------------------------------ */

function SlackConnectionBadge({ status }: { status: SlackStatusEvent | null }) {
  const state = status?.state ?? 'disabled'
  const className =
    state === 'connected'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : state === 'connecting'
        ? 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400'
        : state === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border/50 bg-muted/50 text-muted-foreground'
  return (
    <Badge variant="outline" className={cn('capitalize', className)}>
      {state}
    </Badge>
  )
}

function TelegramConnectionBadge({ status }: { status: TelegramStatusEvent | null }) {
  const state = status?.state ?? 'disabled'
  const className =
    state === 'connected'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : state === 'connecting'
        ? 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400'
        : state === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border/50 bg-muted/50 text-muted-foreground'
  return (
    <Badge variant="outline" className={cn('capitalize', className)}>
      {state}
    </Badge>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  const switchId = useId()
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border/70 p-3">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={switchId} className="text-xs font-medium text-foreground">
          {label}
        </Label>
        {description ? <p className="text-[11px] text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={switchId} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function FeedbackBanner({ error, success }: { error: string | null; success: string | null }) {
  return (
    <>
      {error ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      ) : null}
      {success ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
          <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <p className="text-xs text-emerald-600 dark:text-emerald-400">{success}</p>
        </div>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Main integrations settings tab                                    */
/* ------------------------------------------------------------------ */

interface SettingsIntegrationsProps {
  wsUrl: string
  managers: AgentDescriptor[]
  slackStatus?: SlackStatusEvent | null
  telegramStatus?: TelegramStatusEvent | null
}

export function SettingsIntegrations({
  wsUrl,
  managers,
  slackStatus,
  telegramStatus,
}: SettingsIntegrationsProps) {
  const managerOptions = useMemo(
    () => managers.filter((agent) => agent.role === 'manager'),
    [managers],
  )
  const [selectedIntegrationManagerId, setSelectedIntegrationManagerId] = useState<string>('')

  useEffect(() => {
    setSelectedIntegrationManagerId((previous) => {
      const availableIds = managerOptions.map((m) => m.agentId)
      if (availableIds.includes(previous)) return previous
      return availableIds[0] ?? ''
    })
  }, [managerOptions])

  // ---- Slack state ----
  const [slackConfig, setSlackConfig] = useState<SlackSettingsConfig | null>(null)
  const [slackDraft, setSlackDraft] = useState<SlackDraft | null>(null)
  const [slackChannels, setSlackChannels] = useState<SlackChannelDescriptor[]>([])
  const [slackStatusFromApi, setSlackStatusFromApi] = useState<SlackStatusEvent | null>(null)
  const [slackError, setSlackError] = useState<string | null>(null)
  const [slackSuccess, setSlackSuccess] = useState<string | null>(null)
  const [isLoadingSlack, setIsLoadingSlack] = useState(false)
  const [isSavingSlack, setIsSavingSlack] = useState(false)
  const [isTestingSlack, setIsTestingSlack] = useState(false)
  const [isDisablingSlack, setIsDisablingSlack] = useState(false)
  const [isLoadingChannels, setIsLoadingChannels] = useState(false)

  // ---- Telegram state ----
  const [telegramConfig, setTelegramConfig] = useState<TelegramSettingsConfig | null>(null)
  const [telegramDraft, setTelegramDraft] = useState<TelegramDraft | null>(null)
  const [telegramStatusFromApi, setTelegramStatusFromApi] = useState<TelegramStatusEvent | null>(null)
  const [telegramError, setTelegramError] = useState<string | null>(null)
  const [telegramSuccess, setTelegramSuccess] = useState<string | null>(null)
  const [isLoadingTelegram, setIsLoadingTelegram] = useState(false)
  const [isSavingTelegram, setIsSavingTelegram] = useState(false)
  const [isTestingTelegram, setIsTestingTelegram] = useState(false)
  const [isDisablingTelegram, setIsDisablingTelegram] = useState(false)

  const effectiveSlackStatus =
    slackStatus && (!slackStatus.managerId || slackStatus.managerId === selectedIntegrationManagerId)
      ? slackStatus
      : slackStatusFromApi
  const effectiveTelegramStatus =
    telegramStatus && (!telegramStatus.managerId || telegramStatus.managerId === selectedIntegrationManagerId)
      ? telegramStatus
      : telegramStatusFromApi
  const hasSelectedIntegrationManager = selectedIntegrationManagerId.trim().length > 0

  // ---- Load functions ----
  const loadSlack = useCallback(async () => {
    if (!hasSelectedIntegrationManager) {
      setSlackConfig(null)
      setSlackDraft(null)
      setSlackChannels([])
      setSlackStatusFromApi(null)
      setSlackError(null)
      return
    }

    setIsLoadingSlack(true)
    setSlackError(null)
    try {
      const result = await fetchSlackSettings(wsUrl, selectedIntegrationManagerId)
      setSlackConfig(result.config)
      setSlackDraft(toSlackDraft(result.config))
      setSlackStatusFromApi(result.status)
      setSlackChannels([])
    } catch (err) {
      setSlackError(toErrorMessage(err))
    } finally {
      setIsLoadingSlack(false)
    }
  }, [hasSelectedIntegrationManager, wsUrl, selectedIntegrationManagerId])

  const loadTelegram = useCallback(async () => {
    if (!hasSelectedIntegrationManager) {
      setTelegramConfig(null)
      setTelegramDraft(null)
      setTelegramStatusFromApi(null)
      setTelegramError(null)
      return
    }

    setIsLoadingTelegram(true)
    setTelegramError(null)
    try {
      const result = await fetchTelegramSettings(wsUrl, selectedIntegrationManagerId)
      setTelegramConfig(result.config)
      setTelegramDraft(toTelegramDraft(result.config))
      setTelegramStatusFromApi(result.status)
    } catch (err) {
      setTelegramError(toErrorMessage(err))
    } finally {
      setIsLoadingTelegram(false)
    }
  }, [hasSelectedIntegrationManager, wsUrl, selectedIntegrationManagerId])

  useEffect(() => {
    void Promise.all([loadSlack(), loadTelegram()])
  }, [loadSlack, loadTelegram])

  // ---- Slack handlers ----
  const handleSaveSlack = async () => {
    if (!slackDraft || !hasSelectedIntegrationManager) return
    setSlackError(null); setSlackSuccess(null); setIsSavingSlack(true)
    try {
      const updated = await updateSlackSettings(wsUrl, selectedIntegrationManagerId, buildSlackPatch(slackDraft))
      setSlackConfig(updated.config); setSlackDraft(toSlackDraft(updated.config)); setSlackStatusFromApi(updated.status)
      setSlackSuccess('Slack settings saved.')
    } catch (error) { setSlackError(toErrorMessage(error)) } finally { setIsSavingSlack(false) }
  }

  const handleTestSlack = async () => {
    if (!slackDraft || !hasSelectedIntegrationManager) return
    setSlackError(null); setSlackSuccess(null); setIsTestingSlack(true)
    const patch: Record<string, unknown> = {}
    if (slackDraft.appToken.trim()) patch.appToken = slackDraft.appToken.trim()
    if (slackDraft.botToken.trim()) patch.botToken = slackDraft.botToken.trim()
    try {
      const result = await testSlackConnection(wsUrl, selectedIntegrationManagerId, Object.keys(patch).length > 0 ? patch : undefined)
      const workspace = result.teamName ?? result.teamId ?? 'Slack workspace'
      const identity = result.botUserId ? ` as ${result.botUserId}` : ''
      setSlackSuccess(`Connected to ${workspace}${identity}.`)
      await loadSlack()
    } catch (error) { setSlackError(toErrorMessage(error)) } finally { setIsTestingSlack(false) }
  }

  const handleDisableSlack = async () => {
    if (!hasSelectedIntegrationManager) return
    setSlackError(null); setSlackSuccess(null); setIsDisablingSlack(true)
    try {
      const disabled = await disableSlackSettings(wsUrl, selectedIntegrationManagerId)
      setSlackConfig(disabled.config); setSlackDraft(toSlackDraft(disabled.config)); setSlackStatusFromApi(disabled.status)
      setSlackSuccess('Slack integration disabled.')
    } catch (error) { setSlackError(toErrorMessage(error)) } finally { setIsDisablingSlack(false) }
  }

  const handleLoadChannels = async () => {
    if (!slackDraft || !hasSelectedIntegrationManager) return
    setSlackError(null); setIsLoadingChannels(true)
    try {
      const channels = await fetchSlackChannels(wsUrl, selectedIntegrationManagerId, slackDraft.includePrivateChannels)
      setSlackChannels(channels)
      setSlackSuccess(`Loaded ${channels.length} channel${channels.length === 1 ? '' : 's'}.`)
    } catch (error) { setSlackError(toErrorMessage(error)) } finally { setIsLoadingChannels(false) }
  }

  // ---- Telegram handlers ----
  const handleSaveTelegram = async () => {
    if (!telegramDraft || !hasSelectedIntegrationManager) return
    setTelegramError(null); setTelegramSuccess(null); setIsSavingTelegram(true)
    try {
      const updated = await updateTelegramSettings(wsUrl, selectedIntegrationManagerId, buildTelegramPatch(telegramDraft))
      setTelegramConfig(updated.config); setTelegramDraft(toTelegramDraft(updated.config)); setTelegramStatusFromApi(updated.status)
      setTelegramSuccess('Telegram settings saved.')
    } catch (error) { setTelegramError(toErrorMessage(error)) } finally { setIsSavingTelegram(false) }
  }

  const handleTestTelegram = async () => {
    if (!telegramDraft || !hasSelectedIntegrationManager) return
    setTelegramError(null); setTelegramSuccess(null); setIsTestingTelegram(true)
    const patch: Record<string, unknown> = {}
    if (telegramDraft.botToken.trim()) patch.botToken = telegramDraft.botToken.trim()
    try {
      const result = await testTelegramConnection(wsUrl, selectedIntegrationManagerId, Object.keys(patch).length > 0 ? patch : undefined)
      const identity = result.botUsername ?? result.botDisplayName ?? result.botId ?? 'Telegram bot'
      setTelegramSuccess(`Connected to ${identity}.`)
      await loadTelegram()
    } catch (error) { setTelegramError(toErrorMessage(error)) } finally { setIsTestingTelegram(false) }
  }

  const handleDisableTelegram = async () => {
    if (!hasSelectedIntegrationManager) return
    setTelegramError(null); setTelegramSuccess(null); setIsDisablingTelegram(true)
    try {
      const disabled = await disableTelegramSettings(wsUrl, selectedIntegrationManagerId)
      setTelegramConfig(disabled.config); setTelegramDraft(toTelegramDraft(disabled.config)); setTelegramStatusFromApi(disabled.status)
      setTelegramSuccess('Telegram integration disabled.')
    } catch (error) { setTelegramError(toErrorMessage(error)) } finally { setIsDisablingTelegram(false) }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Manager picker */}
      <SettingsSection
        label="Manager"
        description="Slack and Telegram settings apply to the selected manager agent."
      >
        <SettingsWithCTA label="Active manager" description="Select which manager handles integrations">
          <Select
            value={hasSelectedIntegrationManager ? selectedIntegrationManagerId : undefined}
            disabled={managerOptions.length === 0}
            onValueChange={(value) => {
              setSelectedIntegrationManagerId(value ?? '')
              setSlackError(null); setSlackSuccess(null)
              setTelegramError(null); setTelegramSuccess(null)
            }}
          >
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue placeholder="Select manager" />
            </SelectTrigger>
            <SelectContent>
              {managerOptions.length === 0 ? (
                <SelectItem value="__no_manager__" disabled>No managers available</SelectItem>
              ) : (
                managerOptions.map((m) => (
                  <SelectItem key={m.agentId} value={m.agentId}>{m.agentId}</SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {!hasSelectedIntegrationManager ? (
            <p className="text-[11px] text-muted-foreground">Create a manager to configure Slack and Telegram.</p>
          ) : null}
        </SettingsWithCTA>
      </SettingsSection>

      {/* Slack */}
      <SettingsSection
        label="Slack"
        description="Socket Mode + DM/channel routing"
        cta={<SlackConnectionBadge status={effectiveSlackStatus} />}
      >
        {effectiveSlackStatus?.message ? <p className="text-[11px] text-muted-foreground">{effectiveSlackStatus.message}</p> : null}
        <FeedbackBanner error={slackError} success={slackSuccess} />
        {!hasSelectedIntegrationManager ? (
          <p className="text-[11px] text-muted-foreground">Select a manager to configure Slack integration.</p>
        ) : isLoadingSlack || !slackDraft ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow label="Enable Slack integration" description="Slack stays opt-in until explicitly enabled." checked={slackDraft.enabled} onChange={(next) => setSlackDraft((prev) => (prev ? { ...prev, enabled: next } : prev))} />
              <ToggleRow label="Listen to DMs" description="Handle message.im events as required replies." checked={slackDraft.listenDm} onChange={(next) => setSlackDraft((prev) => (prev ? { ...prev, listenDm: next } : prev))} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow label="Respond in thread" description="Reply in existing thread or start one when possible." checked={slackDraft.respondInThread} onChange={(next) => setSlackDraft((prev) => (prev ? { ...prev, respondInThread: next } : prev))} />
              <ToggleRow label="Reply broadcast" description="Broadcast thread replies to channel." checked={slackDraft.replyBroadcast} onChange={(next) => setSlackDraft((prev) => (prev ? { ...prev, replyBroadcast: next } : prev))} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow label="Include private channels" description="Allow private channel/group events." checked={slackDraft.includePrivateChannels} onChange={(next) => setSlackDraft((prev) => (prev ? { ...prev, includePrivateChannels: next } : prev))} />
              <ToggleRow label="Allow image attachments" description="Download inbound Slack images." checked={slackDraft.allowImages} onChange={(next) => setSlackDraft((prev) => (prev ? { ...prev, allowImages: next } : prev))} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow label="Allow text attachments" description="Include text/* files as prompt attachments." checked={slackDraft.allowText} onChange={(next) => setSlackDraft((prev) => (prev ? { ...prev, allowText: next } : prev))} />
              <ToggleRow label="Allow binary attachments" description="Enable binary file ingestion (base64)." checked={slackDraft.allowBinary} onChange={(next) => setSlackDraft((prev) => (prev ? { ...prev, allowBinary: next } : prev))} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="slack-app-token" className="text-xs font-medium text-muted-foreground">App token (xapp-…)</Label>
                <Input id="slack-app-token" type="password" value={slackDraft.appToken} onChange={(e) => setSlackDraft((prev) => (prev ? { ...prev, appToken: e.target.value } : prev))} placeholder={slackConfig?.appToken ?? 'xapp-...'} autoComplete="off" spellCheck={false} />
                <p className="text-[11px] text-muted-foreground">{slackConfig?.hasAppToken ? 'Token saved. Enter a new value to rotate.' : 'Token not set yet.'}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="slack-bot-token" className="text-xs font-medium text-muted-foreground">Bot token (xoxb-…)</Label>
                <Input id="slack-bot-token" type="password" value={slackDraft.botToken} onChange={(e) => setSlackDraft((prev) => (prev ? { ...prev, botToken: e.target.value } : prev))} placeholder={slackConfig?.botToken ?? 'xoxb-...'} autoComplete="off" spellCheck={false} />
                <p className="text-[11px] text-muted-foreground">{slackConfig?.hasBotToken ? 'Token saved. Enter a new value to rotate.' : 'Token not set yet.'}</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="slack-max-file-bytes" className="text-xs font-medium text-muted-foreground">Max attachment size (bytes)</Label>
              <Input id="slack-max-file-bytes" value={slackDraft.maxFileBytes} onChange={(e) => setSlackDraft((prev) => (prev ? { ...prev, maxFileBytes: e.target.value } : prev))} placeholder="10485760" inputMode="numeric" />
            </div>
            <div className="space-y-2 rounded-md border border-border/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium">Channel picker</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void handleLoadChannels()} disabled={isLoadingChannels || !hasSelectedIntegrationManager}>
                  {isLoadingChannels ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
                  {isLoadingChannels ? 'Loading...' : 'Refresh channels'}
                </Button>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="slack-channel-ids" className="text-xs font-medium text-muted-foreground">Channel IDs</Label>
                <Input id="slack-channel-ids" value={slackDraft.channelIds.join(', ')} onChange={(e) => setSlackDraft((prev) => (prev ? { ...prev, channelIds: parseCommaSeparated(e.target.value) } : prev))} placeholder="C12345, C23456" />
              </div>
              {slackChannels.length > 0 ? (
                <ScrollArea className="h-40 rounded border border-border/60">
                  <div className="space-y-1 p-2">
                    {slackChannels.map((channel) => {
                      const checked = slackDraft.channelIds.includes(channel.id)
                      const checkboxId = `slack-channel-${channel.id}`
                      return (
                        <div key={channel.id} className="flex items-center gap-2 text-xs">
                          <Checkbox id={checkboxId} checked={checked} onCheckedChange={(nextChecked) => setSlackDraft((prev) => {
                            if (!prev) return prev
                            const nextIds = new Set(prev.channelIds)
                            if (nextChecked === true) nextIds.add(channel.id); else nextIds.delete(channel.id)
                            return { ...prev, channelIds: [...nextIds] }
                          })} />
                          <Label htmlFor={checkboxId} className="cursor-pointer text-xs font-normal">
                            <span className="font-medium">#{channel.name}</span>
                            <span className="font-mono text-muted-foreground">({channel.id})</span>
                            {!channel.isMember ? <span className="text-muted-foreground"> not joined</span> : null}
                          </Label>
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>
              ) : <p className="text-[11px] text-muted-foreground">No channel list loaded yet. Use Refresh channels.</p>}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => void handleTestSlack()} disabled={isTestingSlack || !hasSelectedIntegrationManager} className="gap-1.5">
                {isTestingSlack ? <Loader2 className="size-3.5 animate-spin" /> : <TestTube2 className="size-3.5" />}
                {isTestingSlack ? 'Testing...' : 'Test connection'}
              </Button>
              <Button type="button" variant="outline" onClick={() => void handleDisableSlack()} disabled={isDisablingSlack || !hasSelectedIntegrationManager} className="gap-1.5">
                {isDisablingSlack ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                {isDisablingSlack ? 'Disabling...' : 'Disable'}
              </Button>
              <Button type="button" onClick={() => void handleSaveSlack()} disabled={isSavingSlack || !hasSelectedIntegrationManager} className="gap-1.5">
                {isSavingSlack ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                {isSavingSlack ? 'Saving...' : 'Save Slack settings'}
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>

      {/* Telegram */}
      <SettingsSection
        label="Telegram"
        description="Bot API + long polling delivery"
        cta={<TelegramConnectionBadge status={effectiveTelegramStatus} />}
      >
        {effectiveTelegramStatus?.message ? <p className="text-[11px] text-muted-foreground">{effectiveTelegramStatus.message}</p> : null}
        <FeedbackBanner error={telegramError} success={telegramSuccess} />
        {!hasSelectedIntegrationManager ? (
          <p className="text-[11px] text-muted-foreground">Select a manager to configure Telegram integration.</p>
        ) : isLoadingTelegram || !telegramDraft ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow label="Enable Telegram integration" description="Telegram stays opt-in until explicitly enabled." checked={telegramDraft.enabled} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, enabled: next } : prev))} />
              <ToggleRow label="Drop pending updates on start" description="Skip backlog and only process new updates after startup." checked={telegramDraft.dropPendingUpdatesOnStart} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, dropPendingUpdatesOnStart: next } : prev))} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow label="Disable link previews" description="Send outbound messages without link preview cards." checked={telegramDraft.disableLinkPreview} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, disableLinkPreview: next } : prev))} />
              <ToggleRow label="Reply to inbound message" description="Reply to the triggering Telegram message by default." checked={telegramDraft.replyToInboundMessageByDefault} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, replyToInboundMessageByDefault: next } : prev))} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow label="Allow image attachments" description="Ingest Telegram image uploads as Middleman attachments." checked={telegramDraft.allowImages} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, allowImages: next } : prev))} />
              <ToggleRow label="Allow text attachments" description="Include text-like documents as prompt attachments." checked={telegramDraft.allowText} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, allowText: next } : prev))} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow label="Allow binary attachments" description="Enable binary document ingestion (base64)." checked={telegramDraft.allowBinary} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, allowBinary: next } : prev))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="telegram-bot-token" className="text-xs font-medium text-muted-foreground">Bot token</Label>
              <Input id="telegram-bot-token" type="password" value={telegramDraft.botToken} onChange={(e) => setTelegramDraft((prev) => (prev ? { ...prev, botToken: e.target.value } : prev))} placeholder={telegramConfig?.botToken ?? '123456:ABC-...'} autoComplete="off" spellCheck={false} />
              <p className="text-[11px] text-muted-foreground">{telegramConfig?.hasBotToken ? 'Token saved. Enter a new value to rotate.' : 'Token not set yet.'}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="telegram-allowed-user-ids" className="text-xs font-medium text-muted-foreground">Allowed users</Label>
              <Input id="telegram-allowed-user-ids" value={telegramDraft.allowedUserIds.join(', ')} onChange={(e) => setTelegramDraft((prev) => (prev ? { ...prev, allowedUserIds: parseCommaSeparated(e.target.value) } : prev))} placeholder="123456789, 987654321" />
              <p className="text-[11px] text-muted-foreground">Leave empty to allow all users.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="telegram-timeout-seconds" className="text-xs font-medium text-muted-foreground">Poll timeout (seconds)</Label>
                <Input id="telegram-timeout-seconds" value={telegramDraft.timeoutSeconds} onChange={(e) => setTelegramDraft((prev) => (prev ? { ...prev, timeoutSeconds: e.target.value } : prev))} placeholder="25" inputMode="numeric" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="telegram-limit" className="text-xs font-medium text-muted-foreground">Poll limit</Label>
                <Input id="telegram-limit" value={telegramDraft.limit} onChange={(e) => setTelegramDraft((prev) => (prev ? { ...prev, limit: e.target.value } : prev))} placeholder="100" inputMode="numeric" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="telegram-max-file-bytes" className="text-xs font-medium text-muted-foreground">Max attachment size (bytes)</Label>
              <Input id="telegram-max-file-bytes" value={telegramDraft.maxFileBytes} onChange={(e) => setTelegramDraft((prev) => (prev ? { ...prev, maxFileBytes: e.target.value } : prev))} placeholder="10485760" inputMode="numeric" />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => void handleTestTelegram()} disabled={isTestingTelegram || !hasSelectedIntegrationManager} className="gap-1.5">
                {isTestingTelegram ? <Loader2 className="size-3.5 animate-spin" /> : <TestTube2 className="size-3.5" />}
                {isTestingTelegram ? 'Testing...' : 'Test connection'}
              </Button>
              <Button type="button" variant="outline" onClick={() => void handleDisableTelegram()} disabled={isDisablingTelegram || !hasSelectedIntegrationManager} className="gap-1.5">
                {isDisablingTelegram ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                {isDisablingTelegram ? 'Disabling...' : 'Disable'}
              </Button>
              <Button type="button" onClick={() => void handleSaveTelegram()} disabled={isSavingTelegram || !hasSelectedIntegrationManager} className="gap-1.5">
                {isSavingTelegram ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                {isSavingTelegram ? 'Saving...' : 'Save Telegram settings'}
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
