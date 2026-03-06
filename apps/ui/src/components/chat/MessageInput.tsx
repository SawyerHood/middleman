import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { ArrowUp, Loader2, Mic, Paperclip, Square } from 'lucide-react'
import { AttachedFiles } from '@/components/chat/AttachedFiles'
import { Button } from '@/components/ui/button'
import { MAX_VOICE_RECORDING_DURATION_MS, useVoiceRecorder } from '@/hooks/use-voice-recorder'
import {
  fileToPendingAttachment,
  type PendingAttachment,
} from '@/lib/file-attachments'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { transcribeVoice } from '@/lib/voice-transcription-client'
import { cn } from '@/lib/utils'
import type { ConversationAttachment } from '@middleman/protocol'

const TEXTAREA_MAX_HEIGHT = 186
const ACTIVE_WAVEFORM_BAR_COUNT = 16
const OPENAI_KEY_REQUIRED_MESSAGE = 'OpenAI API key required \u2014 add it in Settings.'

interface MessageInputProps {
  onSend: (message: string, attachments?: ConversationAttachment[]) => void
  isLoading: boolean
  disabled?: boolean
  agentLabel?: string
  allowWhileLoading?: boolean
  wsUrl?: string
}

export interface MessageInputHandle {
  setInput: (value: string) => void
  focus: () => void
  addFiles: (files: File[]) => Promise<void>
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function stretchWaveformBars(source: number[], targetCount: number): number[] {
  if (targetCount <= 0) return []
  if (source.length === 0) return Array.from({ length: targetCount }, () => 0)
  if (source.length === 1) return Array.from({ length: targetCount }, () => source[0] ?? 0)

  return Array.from({ length: targetCount }, (_, index) => {
    const position = (index / (targetCount - 1)) * (source.length - 1)
    const lower = Math.floor(position)
    const upper = Math.min(source.length - 1, Math.ceil(position))
    const ratio = position - lower
    const lowerValue = source[lower] ?? 0
    const upperValue = source[upper] ?? lowerValue
    return lowerValue + (upperValue - lowerValue) * ratio
  })
}

async function hasConfiguredOpenAiKey(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(endpoint)
    if (!response.ok) {
      return false
    }

    const payload = (await response.json()) as {
      providers?: Array<{
        provider?: unknown
        configured?: unknown
      }>
    }

    if (!payload || !Array.isArray(payload.providers)) {
      return false
    }

    return payload.providers.some((provider) => {
      if (!provider || typeof provider !== 'object') {
        return false
      }

      const providerId =
        typeof provider.provider === 'string' ? provider.provider.trim().toLowerCase() : ''
      const configured = provider.configured === true

      return configured && providerId === 'openai-codex'
    })
  } catch {
    return false
  }
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput(
  {
    onSend,
    isLoading,
    disabled = false,
    agentLabel = 'agent',
    allowWhileLoading = false,
    wsUrl,
  },
  ref,
) {
  const [input, setInput] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<PendingAttachment[]>([])
  const [isTranscribingVoice, setIsTranscribingVoice] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const {
    isRecording,
    isRequestingPermission: isRequestingMicrophone,
    durationMs: voiceRecordingDurationMs,
    waveformBars: recordingWaveformBars,
    startRecording,
    stopRecording,
  } = useVoiceRecorder()

  const transcribeEndpoint = useMemo(() => resolveApiEndpoint(wsUrl, '/api/transcribe'), [wsUrl])
  const settingsAuthEndpoint = useMemo(() => resolveApiEndpoint(wsUrl, '/api/settings/auth'), [wsUrl])

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.overflowY = 'hidden'
    textarea.style.height = 'auto'
    const nextHeight = Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT)
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = textarea.scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden'
  }, [])

  const blockedByLoading = isLoading && !allowWhileLoading

  useEffect(() => {
    resizeTextarea()
  }, [input, resizeTextarea])

  useEffect(() => {
    if (!disabled && !blockedByLoading && !isRecording) {
      textareaRef.current?.focus()
    }
  }, [blockedByLoading, disabled, isRecording])

  const addFiles = useCallback(
    async (files: File[]) => {
      if (disabled || isRecording || files.length === 0) return

      const uploaded = await Promise.all(files.map(fileToPendingAttachment))
      const nextAttachments = uploaded.filter((attachment): attachment is PendingAttachment => attachment !== null)

      if (nextAttachments.length === 0) {
        return
      }

      setAttachedFiles((previous) => [...previous, ...nextAttachments])
    },
    [disabled, isRecording],
  )

  useImperativeHandle(
    ref,
    () => ({
      setInput: (value: string) => {
        setInput(value)
        requestAnimationFrame(() => textareaRef.current?.focus())
      },
      focus: () => {
        textareaRef.current?.focus()
      },
      addFiles,
    }),
    [addFiles],
  )

  const handleFileSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    await addFiles(files)
    event.target.value = ''
  }

  const handlePaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)

    if (files.length === 0) return

    event.preventDefault()
    await addFiles(files)
  }

  const removeAttachment = (attachmentId: string) => {
    setAttachedFiles((previous) => previous.filter((attachment) => attachment.id !== attachmentId))
  }

  const appendTranscriptionToInput = useCallback((transcribedText: string): boolean => {
    const trimmedText = transcribedText.trim()
    if (!trimmedText) {
      return false
    }

    setInput((previousInput) => {
      if (!previousInput.trim()) {
        return trimmedText
      }

      const separator = previousInput.endsWith('\n') || previousInput.endsWith(' ') ? '' : '\n'
      return `${previousInput}${separator}${trimmedText}`
    })

    requestAnimationFrame(() => textareaRef.current?.focus())
    return true
  }, [])

  const stopAndTranscribeRecording = useCallback(async () => {
    const recording = await stopRecording()
    if (!recording) {
      setVoiceError('Recording failed. Could not capture audio. Please try again.')
      return
    }

    setIsTranscribingVoice(true)
    setVoiceError(null)

    try {
      const result = await transcribeVoice(recording.blob, transcribeEndpoint)
      const appended = appendTranscriptionToInput(result.text)
      if (!appended) {
        setVoiceError('No speech detected. Try speaking a little louder.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice transcription failed.'
      setVoiceError(message)
    } finally {
      setIsTranscribingVoice(false)
    }
  }, [appendTranscriptionToInput, stopRecording, transcribeEndpoint])

  useEffect(() => {
    if (!isRecording || isTranscribingVoice) return
    if (voiceRecordingDurationMs < MAX_VOICE_RECORDING_DURATION_MS) return
    void stopAndTranscribeRecording()
  }, [isRecording, isTranscribingVoice, stopAndTranscribeRecording, voiceRecordingDurationMs])

  const startInlineRecording = useCallback(async () => {
    const hasOpenAiKey = await hasConfiguredOpenAiKey(settingsAuthEndpoint)
    if (!hasOpenAiKey) {
      setVoiceError(OPENAI_KEY_REQUIRED_MESSAGE)
      return
    }

    try {
      await startRecording()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not access your microphone.'
      setVoiceError(message)
    }
  }, [settingsAuthEndpoint, startRecording])

  const handleVoiceButtonClick = useCallback(() => {
    if (disabled || blockedByLoading || isRequestingMicrophone || isTranscribingVoice) {
      return
    }

    setVoiceError(null)

    if (isRecording) {
      void stopAndTranscribeRecording()
      return
    }

    void startInlineRecording()
  }, [
    blockedByLoading,
    disabled,
    isRecording,
    isRequestingMicrophone,
    isTranscribingVoice,
    startInlineRecording,
    stopAndTranscribeRecording,
  ])

  const submitMessage = useCallback(() => {
    const trimmed = input.trim()
    const hasContent = trimmed.length > 0 || attachedFiles.length > 0
    if (!hasContent || disabled || blockedByLoading || isRecording || isTranscribingVoice) {
      return
    }

    onSend(
      trimmed,
      attachedFiles.length > 0
        ? attachedFiles.map((attachment) => {
            if (attachment.type === 'text') {
              return {
                type: 'text' as const,
                mimeType: attachment.mimeType,
                text: attachment.text,
                fileName: attachment.fileName,
              }
            }

            if (attachment.type === 'binary') {
              return {
                type: 'binary' as const,
                mimeType: attachment.mimeType,
                data: attachment.data,
                fileName: attachment.fileName,
              }
            }

            return {
              mimeType: attachment.mimeType,
              data: attachment.data,
              fileName: attachment.fileName,
            }
          })
        : undefined,
    )

    setInput('')
    setAttachedFiles([])
  }, [attachedFiles, blockedByLoading, disabled, input, isRecording, isTranscribingVoice, onSend])

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      submitMessage()
    },
    [submitMessage],
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitMessage()
    }
  }

  const hasContent = input.trim().length > 0 || attachedFiles.length > 0
  const canSubmit = hasContent && !disabled && !blockedByLoading && !isRecording && !isTranscribingVoice
  const placeholder = disabled
    ? 'Waiting for connection...'
    : allowWhileLoading && isLoading
      ? `Send another message to ${agentLabel}...`
      : `Message ${agentLabel}...`

  const activeWaveformBars = useMemo(
    () => stretchWaveformBars(recordingWaveformBars, ACTIVE_WAVEFORM_BAR_COUNT),
    [recordingWaveformBars],
  )

  const voiceButtonDisabled = disabled || blockedByLoading || isRequestingMicrophone || isTranscribingVoice

  return (
    <form
      data-react-grab-ignore
      onSubmit={handleSubmit}
      className="sticky bottom-0 shrink-0 bg-background p-2 md:p-3"
    >
      <div className="overflow-hidden rounded-2xl border border-border">
        <AttachedFiles attachments={attachedFiles} onRemove={removeAttachment} />

        <div className="group flex flex-col">
          {isRecording ? (
            <div className="flex min-h-[48px] items-center gap-2 border-b border-border/60 bg-red-500/[0.05] px-3 py-2">
              <div className="flex h-7 flex-1 items-center gap-px py-1" aria-hidden>
                {activeWaveformBars.map((bar, index) => {
                  const barHeight = Math.max(2, Math.round(bar * 18))
                  return (
                    <span
                      key={index}
                      className="flex-1 rounded-[1px] bg-red-500/60 transition-[height] duration-150 ease-out"
                      style={{ height: `${barHeight}px` }}
                    />
                  )
                })}
              </div>

              <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                {formatDuration(voiceRecordingDurationMs)}
              </span>

              <button
                type="button"
                className="flex size-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                onClick={() => void stopAndTranscribeRecording()}
                disabled={voiceButtonDisabled}
                aria-label="Stop recording"
              >
                <Square className="size-2 fill-current" />
              </button>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={disabled}
              rows={1}
              className={cn(
                'w-full resize-none border-0 bg-transparent text-sm leading-normal text-foreground shadow-none focus:outline-none',
                'min-h-[44px]',
                'px-4 pt-3 pb-2',
                '[&::-webkit-scrollbar]:w-1.5',
                '[&::-webkit-scrollbar-track]:bg-transparent',
                '[&::-webkit-scrollbar-thumb]:bg-transparent',
                '[&::-webkit-scrollbar-thumb]:rounded-full',
                'group-hover:[&::-webkit-scrollbar-thumb]:bg-border',
              )}
            />
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            aria-label="Attach files"
          />

          <div className="flex items-center justify-between px-1.5 pb-1.5 pt-1">
            <div className="flex items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-full text-muted-foreground/60 hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || isRecording}
                aria-label="Attach files"
              >
                <Paperclip className="size-3.5" />
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'size-7 rounded-full transition-colors',
                  isRecording
                    ? 'text-red-500 hover:bg-red-500/10 hover:text-red-600'
                    : 'text-muted-foreground/60 hover:text-foreground',
                )}
                onClick={handleVoiceButtonClick}
                disabled={voiceButtonDisabled}
                aria-label={isRecording ? 'Stop recording and transcribe' : 'Record voice input'}
              >
                {isRequestingMicrophone || isTranscribingVoice ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : isRecording ? (
                  <Square className="size-3 fill-current" />
                ) : (
                  <Mic className="size-3.5" />
                )}
              </Button>
            </div>

            <Button
              type="submit"
              disabled={!canSubmit}
              size="icon"
              className={cn(
                'size-7 rounded-full transition-all',
                canSubmit
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95'
                  : 'cursor-default bg-muted text-muted-foreground/40',
              )}
              aria-label="Send message"
            >
              <ArrowUp className="size-3.5" strokeWidth={2.5} />
            </Button>
          </div>

          {voiceError ? <p className="px-3 pb-2 text-xs text-destructive">{voiceError}</p> : null}
        </div>
      </div>
    </form>
  )
})
