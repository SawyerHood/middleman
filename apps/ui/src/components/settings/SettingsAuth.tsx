import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  Plug,
  Save,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { SettingsSection } from './settings-row'
import type {
  SettingsAuthProviderId,
  SettingsAuthProvider,
  SettingsAuthOAuthFlowState,
} from './settings-types'
import {
  SETTINGS_AUTH_PROVIDER_META,
  SETTINGS_AUTH_PROVIDER_ORDER,
  DEFAULT_SETTINGS_AUTH_OAUTH_FLOW_STATE,
  createIdleSettingsAuthOAuthFlowState,
  fetchSettingsAuthProviders,
  updateSettingsAuthProviders,
  deleteSettingsAuthProvider,
  startSettingsAuthOAuthLoginStream,
  submitSettingsAuthOAuthPrompt,
  toErrorMessage,
} from './settings-api'

/* ------------------------------------------------------------------ */
/*  Sub-components                                                    */
/* ------------------------------------------------------------------ */

function AuthStatusBadge({ configured }: { configured: boolean }) {
  if (configured) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      >
        <Check className="size-3" />
        Configured
      </Badge>
    )
  }

  return (
    <Badge
      variant="outline"
      className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    >
      <AlertTriangle className="size-3" />
      Not configured
    </Badge>
  )
}

function AuthProviderRow({
  provider,
  authStatus,
  draftValue,
  isRevealed,
  isSaving,
  isDeleting,
  oauthFlow,
  onDraftChange,
  onToggleReveal,
  onSave,
  onDelete,
  onStartOAuth,
  onOAuthCodeChange,
  onSubmitOAuthCode,
  onResetOAuth,
}: {
  provider: SettingsAuthProviderId
  authStatus: SettingsAuthProvider
  draftValue: string
  isRevealed: boolean
  isSaving: boolean
  isDeleting: boolean
  oauthFlow: SettingsAuthOAuthFlowState
  onDraftChange: (value: string) => void
  onToggleReveal: () => void
  onSave: () => void
  onDelete: () => void
  onStartOAuth: () => void
  onOAuthCodeChange: (value: string) => void
  onSubmitOAuthCode: () => void
  onResetOAuth: () => void
}) {
  const metadata = SETTINGS_AUTH_PROVIDER_META[provider]
  const busy = isSaving || isDeleting
  const oauthInProgress =
    oauthFlow.status === 'starting' ||
    oauthFlow.status === 'waiting_for_auth' ||
    oauthFlow.status === 'waiting_for_code'

  return (
    <div className="rounded-lg border border-border bg-card/50 p-4 transition-colors hover:bg-card/80">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-[13px] font-semibold text-foreground">{metadata.label}</p>
            <AuthStatusBadge configured={authStatus.configured} />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{metadata.description}</p>
          {authStatus.configured ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Stored credential: <code className="font-mono">{authStatus.maskedValue ?? '********'}</code>
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-muted-foreground">No credential stored yet.</p>
          )}
        </div>

        <a
          href={metadata.helpUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Get key
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative w-full flex-1">
          <Input
            type={isRevealed ? 'text' : 'password'}
            placeholder={authStatus.configured ? (authStatus.maskedValue ?? metadata.placeholder) : metadata.placeholder}
            value={draftValue}
            onChange={(event) => onDraftChange(event.target.value)}
            className="pr-9 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleReveal}
            disabled={busy}
            className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"
            title={isRevealed ? 'Hide value' : 'Show value'}
          >
            {isRevealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 sm:shrink-0">
          <Button
            type="button"
            size="sm"
            onClick={onSave}
            disabled={!draftValue.trim() || busy}
            className="flex-1 gap-1.5 sm:flex-none"
          >
            {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            {isSaving ? 'Saving' : 'Save'}
          </Button>

          {authStatus.configured ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={busy}
              className="flex-1 gap-1.5 text-muted-foreground hover:text-destructive sm:flex-none"
            >
              {isDeleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              {isDeleting ? 'Removing' : 'Remove'}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        <Separator className="mb-3" />

        <div className="space-y-2 rounded-md border border-border/70 bg-background/40 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">OAuth login</p>
              <p className="text-[11px] text-muted-foreground">
                Authorize in your browser and store refresh/access tokens automatically.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {oauthFlow.status === 'complete' ? (
                <Badge
                  variant="outline"
                  className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                >
                  <Check className="size-3" />
                  Connected
                </Badge>
              ) : null}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onStartOAuth}
                disabled={busy || oauthInProgress || oauthFlow.isSubmittingCode}
                className="gap-1.5"
              >
                {oauthInProgress ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                {oauthInProgress ? 'Authorizing...' : 'Login with OAuth'}
              </Button>
            </div>
          </div>

          {oauthFlow.authUrl ? (
            <a
              href={oauthFlow.authUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-primary hover:bg-muted/50"
            >
              Open authorization URL
              <ExternalLink className="size-3" />
            </a>
          ) : null}

          {oauthFlow.instructions ? (
            <p className="text-[11px] text-muted-foreground">{oauthFlow.instructions}</p>
          ) : null}

          {oauthFlow.progressMessage ? (
            <p className="text-[11px] text-muted-foreground">{oauthFlow.progressMessage}</p>
          ) : null}

          {oauthFlow.status === 'waiting_for_code' ? (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground">
                {oauthFlow.promptMessage ?? 'Paste the authorization code to continue.'}
              </p>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="text"
                  placeholder={oauthFlow.promptPlaceholder ?? 'Paste authorization code or URL'}
                  value={oauthFlow.codeValue}
                  onChange={(event) => onOAuthCodeChange(event.target.value)}
                  disabled={busy || oauthFlow.isSubmittingCode}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />

                <Button
                  type="button"
                  size="sm"
                  onClick={onSubmitOAuthCode}
                  disabled={!oauthFlow.codeValue.trim() || busy || oauthFlow.isSubmittingCode}
                  className="w-full gap-1.5 sm:w-auto"
                >
                  {oauthFlow.isSubmittingCode ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  {oauthFlow.isSubmittingCode ? 'Submitting...' : 'Submit'}
                </Button>
              </div>
            </div>
          ) : null}

          {oauthFlow.errorMessage ? (
            <p className="text-[11px] text-destructive">{oauthFlow.errorMessage}</p>
          ) : null}

          {(oauthFlow.status === 'complete' || oauthFlow.status === 'error') && !oauthInProgress ? (
            <div className="flex justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={onResetOAuth}>
                Clear
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main auth settings tab                                            */
/* ------------------------------------------------------------------ */

interface SettingsAuthProps {
  wsUrl: string
}

export function SettingsAuth({ wsUrl }: SettingsAuthProps) {
  const [authProviders, setAuthProviders] = useState<SettingsAuthProvider[]>([])
  const [authDraftByProvider, setAuthDraftByProvider] = useState<Partial<Record<SettingsAuthProviderId, string>>>({})
  const [authRevealByProvider, setAuthRevealByProvider] = useState<Partial<Record<SettingsAuthProviderId, boolean>>>({})
  const [oauthFlowByProvider, setOauthFlowByProvider] = useState<
    Partial<Record<SettingsAuthProviderId, SettingsAuthOAuthFlowState>>
  >({})
  const oauthAbortControllerByProviderRef = useRef<
    Partial<Record<SettingsAuthProviderId, AbortController>>
  >({})

  const [authError, setAuthError] = useState<string | null>(null)
  const [authSuccess, setAuthSuccess] = useState<string | null>(null)
  const [isLoadingAuth, setIsLoadingAuth] = useState(false)
  const [savingAuthProvider, setSavingAuthProvider] = useState<SettingsAuthProviderId | null>(null)
  const [deletingAuthProvider, setDeletingAuthProvider] = useState<SettingsAuthProviderId | null>(null)

  const authProviderById = useMemo(() => {
    return new Map(authProviders.map((entry) => [entry.provider, entry]))
  }, [authProviders])

  const loadAuth = useCallback(async () => {
    setIsLoadingAuth(true)
    setAuthError(null)
    try {
      const result = await fetchSettingsAuthProviders(wsUrl)
      setAuthProviders(result)
    } catch (err) {
      setAuthError(toErrorMessage(err))
    } finally {
      setIsLoadingAuth(false)
    }
  }, [wsUrl])

  useEffect(() => {
    void loadAuth()
  }, [loadAuth])

  const abortAllOAuthLoginFlows = useCallback(() => {
    for (const provider of SETTINGS_AUTH_PROVIDER_ORDER) {
      const controller = oauthAbortControllerByProviderRef.current[provider]
      if (controller) {
        controller.abort()
      }
    }
    oauthAbortControllerByProviderRef.current = {}
  }, [])

  useEffect(() => {
    return () => {
      abortAllOAuthLoginFlows()
    }
  }, [abortAllOAuthLoginFlows])

  const handleSaveAuth = async (provider: SettingsAuthProviderId) => {
    const value = authDraftByProvider[provider]?.trim() ?? ''
    if (!value) {
      setAuthError(`Enter a value for ${SETTINGS_AUTH_PROVIDER_META[provider].label} before saving.`)
      return
    }
    setAuthError(null)
    setAuthSuccess(null)
    setSavingAuthProvider(provider)
    try {
      await updateSettingsAuthProviders(wsUrl, { [provider]: value })
      setAuthDraftByProvider((prev) => ({ ...prev, [provider]: '' }))
      setAuthSuccess(`${SETTINGS_AUTH_PROVIDER_META[provider].label} saved.`)
      await loadAuth()
    } catch (err) {
      setAuthError(toErrorMessage(err))
    } finally {
      setSavingAuthProvider(null)
    }
  }

  const handleDeleteAuth = async (provider: SettingsAuthProviderId) => {
    setAuthError(null)
    setAuthSuccess(null)
    setDeletingAuthProvider(provider)
    try {
      await deleteSettingsAuthProvider(wsUrl, provider)
      setAuthDraftByProvider((prev) => ({ ...prev, [provider]: '' }))
      setAuthSuccess(`${SETTINGS_AUTH_PROVIDER_META[provider].label} removed.`)
      await loadAuth()
    } catch (err) {
      setAuthError(toErrorMessage(err))
    } finally {
      setDeletingAuthProvider(null)
    }
  }

  const handleStartOAuth = async (provider: SettingsAuthProviderId) => {
    const existingController = oauthAbortControllerByProviderRef.current[provider]
    if (existingController) {
      existingController.abort()
    }

    const controller = new AbortController()
    oauthAbortControllerByProviderRef.current[provider] = controller

    setAuthError(null)
    setAuthSuccess(null)
    setOauthFlowByProvider((prev) => ({
      ...prev,
      [provider]: {
        ...createIdleSettingsAuthOAuthFlowState(),
        status: 'starting',
        progressMessage: 'Waiting for authorization instructions...',
      },
    }))

    let completed = false

    try {
      await startSettingsAuthOAuthLoginStream(
        wsUrl,
        provider,
        {
          onAuthUrl: (event) => {
            setOauthFlowByProvider((prev) => {
              const current = prev[provider] ?? createIdleSettingsAuthOAuthFlowState()
              return {
                ...prev,
                [provider]: {
                  ...current,
                  status: current.status === 'waiting_for_code' ? 'waiting_for_code' : 'waiting_for_auth',
                  authUrl: event.url,
                  instructions: event.instructions,
                  errorMessage: undefined,
                },
              }
            })
          },
          onPrompt: (event) => {
            setOauthFlowByProvider((prev) => {
              const current = prev[provider] ?? createIdleSettingsAuthOAuthFlowState()
              return {
                ...prev,
                [provider]: {
                  ...current,
                  status: 'waiting_for_code',
                  promptMessage: event.message,
                  promptPlaceholder: event.placeholder,
                  errorMessage: undefined,
                },
              }
            })
          },
          onProgress: (event) => {
            setOauthFlowByProvider((prev) => {
              const current = prev[provider] ?? createIdleSettingsAuthOAuthFlowState()
              return {
                ...prev,
                [provider]: {
                  ...current,
                  status: current.status === 'waiting_for_code' ? 'waiting_for_code' : 'waiting_for_auth',
                  progressMessage: event.message,
                },
              }
            })
          },
          onComplete: () => {
            completed = true
            setAuthError(null)
            setAuthSuccess(`${SETTINGS_AUTH_PROVIDER_META[provider].label} connected via OAuth.`)
            setOauthFlowByProvider((prev) => ({
              ...prev,
              [provider]: {
                ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
                status: 'complete',
                errorMessage: undefined,
                progressMessage: 'Connected.',
                isSubmittingCode: false,
                codeValue: '',
              },
            }))
          },
          onError: (message) => {
            setAuthError(message)
            setOauthFlowByProvider((prev) => ({
              ...prev,
              [provider]: {
                ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
                status: 'error',
                errorMessage: message,
                isSubmittingCode: false,
              },
            }))
          },
        },
        controller.signal,
      )

      if (!controller.signal.aborted && completed) {
        await loadAuth()
      }
    } catch (error) {
      if (controller.signal.aborted) return
      const message = toErrorMessage(error)
      setAuthError(message)
      setOauthFlowByProvider((prev) => ({
        ...prev,
        [provider]: {
          ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
          status: 'error',
          errorMessage: message,
          isSubmittingCode: false,
        },
      }))
    } finally {
      if (oauthAbortControllerByProviderRef.current[provider] === controller) {
        delete oauthAbortControllerByProviderRef.current[provider]
      }
    }
  }

  const handleSubmitOAuthPrompt = async (provider: SettingsAuthProviderId) => {
    const flow = oauthFlowByProvider[provider] ?? createIdleSettingsAuthOAuthFlowState()
    const value = flow.codeValue.trim()
    if (!value) {
      setAuthError('Enter the authorization code before submitting.')
      return
    }
    setAuthError(null)
    setAuthSuccess(null)
    setOauthFlowByProvider((prev) => ({
      ...prev,
      [provider]: {
        ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
        isSubmittingCode: true,
        errorMessage: undefined,
      },
    }))
    try {
      await submitSettingsAuthOAuthPrompt(wsUrl, provider, value)
      setOauthFlowByProvider((prev) => ({
        ...prev,
        [provider]: {
          ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
          status: 'waiting_for_auth',
          codeValue: '',
          isSubmittingCode: false,
          progressMessage: 'Authorization code submitted. Waiting for completion...',
          errorMessage: undefined,
        },
      }))
    } catch (error) {
      const message = toErrorMessage(error)
      setAuthError(message)
      setOauthFlowByProvider((prev) => ({
        ...prev,
        [provider]: {
          ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
          status: 'waiting_for_code',
          isSubmittingCode: false,
          errorMessage: message,
        },
      }))
    }
  }

  const handleResetOAuthFlow = (provider: SettingsAuthProviderId) => {
    const controller = oauthAbortControllerByProviderRef.current[provider]
    if (controller) {
      controller.abort()
      delete oauthAbortControllerByProviderRef.current[provider]
    }
    setOauthFlowByProvider((prev) => ({
      ...prev,
      [provider]: createIdleSettingsAuthOAuthFlowState(),
    }))
  }

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        label="API Keys"
        description="Stored in ~/.middleman/auth/auth.json"
      >
        {authError ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
            <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
            <p className="text-xs text-destructive">{authError}</p>
          </div>
        ) : null}

        {authSuccess ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
            <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <p className="text-xs text-emerald-600 dark:text-emerald-400">{authSuccess}</p>
          </div>
        ) : null}

        {isLoadingAuth ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            {SETTINGS_AUTH_PROVIDER_ORDER.map((provider) => {
              const authStatus = authProviderById.get(provider) ?? {
                provider,
                configured: false,
              }

              return (
                <AuthProviderRow
                  key={provider}
                  provider={provider}
                  authStatus={authStatus}
                  draftValue={authDraftByProvider[provider] ?? ''}
                  isRevealed={authRevealByProvider[provider] === true}
                  isSaving={savingAuthProvider === provider}
                  isDeleting={deletingAuthProvider === provider}
                  oauthFlow={oauthFlowByProvider[provider] ?? DEFAULT_SETTINGS_AUTH_OAUTH_FLOW_STATE}
                  onDraftChange={(value) => {
                    setAuthDraftByProvider((prev) => ({ ...prev, [provider]: value }))
                    setAuthError(null)
                    setAuthSuccess(null)
                  }}
                  onToggleReveal={() =>
                    setAuthRevealByProvider((prev) => ({ ...prev, [provider]: !prev[provider] }))
                  }
                  onSave={() => void handleSaveAuth(provider)}
                  onDelete={() => void handleDeleteAuth(provider)}
                  onStartOAuth={() => void handleStartOAuth(provider)}
                  onOAuthCodeChange={(value) => {
                    setOauthFlowByProvider((prev) => ({
                      ...prev,
                      [provider]: {
                        ...(prev[provider] ?? createIdleSettingsAuthOAuthFlowState()),
                        codeValue: value,
                        errorMessage: undefined,
                      },
                    }))
                    setAuthError(null)
                  }}
                  onSubmitOAuthCode={() => void handleSubmitOAuthPrompt(provider)}
                  onResetOAuth={() => handleResetOAuthFlow(provider)}
                />
              )
            })}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
