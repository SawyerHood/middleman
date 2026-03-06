import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CalendarDays, ListTodo, MessageSquare, PanelLeft, UserRound, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, UserTask } from '@middleman/protocol'

interface TaskViewProps {
  tasks: UserTask[]
  managers: AgentDescriptor[]
  onAddTaskComment: (taskId: string, comment: string) => Promise<void>
  onBack: () => void
  onCompleteTask: (taskId: string) => Promise<void>
  onToggleMobileSidebar: () => void
  onUpdateTask: (input: { taskId: string; title?: string; description?: string }) => Promise<void>
}

type EditableField = 'title' | 'description' | null

export function TaskView({
  tasks,
  managers,
  onAddTaskComment,
  onBack,
  onCompleteTask,
  onToggleMobileSidebar,
  onUpdateTask,
}: TaskViewProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null)
  const [completionError, setCompletionError] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentError, setCommentError] = useState<string | null>(null)
  const [commentingTaskId, setCommentingTaskId] = useState<string | null>(null)
  const [editingField, setEditingField] = useState<EditableField>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [updatingField, setUpdatingField] = useState<EditableField>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const skipNextBlurSaveRef = useRef<EditableField>(null)

  const managerNameById = useMemo(
    () => new Map(managers.map((manager) => [manager.agentId, manager.displayName || manager.agentId])),
    [managers],
  )

  const sortedTasks = useMemo(() => [...tasks].sort(compareTasks), [tasks])
  const selectedTask = useMemo(
    () => sortedTasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, sortedTasks],
  )
  const selectedTaskComments = useMemo(() => {
    if (!selectedTask) {
      return []
    }

    if (selectedTask.comments && selectedTask.comments.length > 0) {
      return [...selectedTask.comments].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    }

    if (selectedTask.status === 'completed' && selectedTask.completedAt) {
      return [
        {
          id: `${selectedTask.id}-completion`,
          body: selectedTask.completionComment ?? 'Task completed.',
          createdAt: selectedTask.completedAt,
          type: 'completion' as const,
        },
      ]
    }

    return []
  }, [selectedTask])

  const pendingCount = sortedTasks.filter((task) => task.status === 'pending').length

  useEffect(() => {
    if (selectedTaskId && !selectedTask) {
      setSelectedTaskId(null)
      setEditingField(null)
      setCompletionError(null)
      setCommentDraft('')
      setCommentError(null)
      setUpdateError(null)
    }
  }, [selectedTask, selectedTaskId])

  useEffect(() => {
    setCommentDraft('')
    setCommentError(null)
    setCompletionError(null)
  }, [selectedTask?.id])

  useEffect(() => {
    if (!selectedTask) {
      return
    }

    if (editingField !== 'title') {
      setTitleDraft(selectedTask.title)
    }
    if (editingField !== 'description') {
      setDescriptionDraft(selectedTask.description ?? '')
    }
  }, [editingField, selectedTask])

  const handleQuickComplete = async (taskId: string) => {
    setCompletingTaskId(taskId)
    setCompletionError(null)

    try {
      await onCompleteTask(taskId)
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : 'Failed to complete task.')
    } finally {
      setCompletingTaskId((currentTaskId) => (currentTaskId === taskId ? null : currentTaskId))
    }
  }

  const handleDetailComplete = async () => {
    if (!selectedTask) {
      return
    }

    setCompletingTaskId(selectedTask.id)
    setCompletionError(null)

    try {
      await onCompleteTask(selectedTask.id)
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : 'Failed to complete task.')
    } finally {
      setCompletingTaskId((currentTaskId) => (currentTaskId === selectedTask.id ? null : currentTaskId))
    }
  }

  const handleAddComment = async () => {
    if (!selectedTask) {
      return
    }

    setCommentingTaskId(selectedTask.id)
    setCommentError(null)

    try {
      await onAddTaskComment(selectedTask.id, commentDraft)
      setCommentDraft('')
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : 'Failed to send comment.')
    } finally {
      setCommentingTaskId((currentTaskId) => (currentTaskId === selectedTask.id ? null : currentTaskId))
    }
  }

  const shouldSkipBlurSave = (field: Exclude<EditableField, null>): boolean => {
    if (skipNextBlurSaveRef.current !== field) {
      return false
    }

    skipNextBlurSaveRef.current = null
    return true
  }

  const saveTitle = async () => {
    if (!selectedTask) {
      return
    }

    const nextTitle = titleDraft.trim()
    if (!nextTitle) {
      setTitleDraft(selectedTask.title)
      setUpdateError('Title cannot be empty.')
      return
    }

    if (nextTitle === selectedTask.title) {
      setEditingField(null)
      setUpdateError(null)
      return
    }

    setUpdatingField('title')
    setUpdateError(null)

    try {
      await onUpdateTask({
        taskId: selectedTask.id,
        title: nextTitle,
      })
      setEditingField(null)
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'Failed to update title.')
    } finally {
      setUpdatingField((currentField) => (currentField === 'title' ? null : currentField))
    }
  }

  const saveDescription = async () => {
    if (!selectedTask) {
      return
    }

    const nextDescription = descriptionDraft.trim()
    const currentDescription = selectedTask.description ?? ''
    if (nextDescription === currentDescription) {
      setEditingField(null)
      setUpdateError(null)
      return
    }

    setUpdatingField('description')
    setUpdateError(null)

    try {
      await onUpdateTask({
        taskId: selectedTask.id,
        description: nextDescription,
      })
      setEditingField(null)
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'Failed to update description.')
    } finally {
      setUpdatingField((currentField) => (currentField === 'description' ? null : currentField))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* ── Header ── */}
      <div className="mb-2 flex h-[62px] shrink-0 items-center justify-between border-b border-border/50 px-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            onClick={onToggleMobileSidebar}
            aria-label="Open sidebar"
          >
            <PanelLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold text-foreground">Your Tasks</h1>
              <span className="text-xs tabular-nums text-muted-foreground">
                {pendingCount > 0 ? `${pendingCount} open` : `${sortedTasks.length} total`}
              </span>
            </div>
            <p className="text-[11px] leading-tight text-muted-foreground/70">Assigned to you by agents</p>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          Back
        </Button>
      </div>

      {/* ── Content ── */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* ── Task list ── */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            {sortedTasks.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <ListTodo className="mx-auto mb-3 size-5 text-muted-foreground/40" />
                <p className="text-sm font-medium text-foreground/70">No tasks yet</p>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  When agents assign you tasks, they'll appear here.
                </p>
              </div>
            ) : (
              <div>
                {sortedTasks.map((task) => {
                  const managerName = managerNameById.get(task.managerId) ?? task.managerId
                  const isSelected = selectedTaskId === task.id
                  const isCompleting = completingTaskId === task.id

                  return (
                    <div
                      key={task.id}
                      className={cn(
                        'group flex items-center gap-3 border-b border-border/30 px-4 py-2.5 transition-colors duration-100',
                        isSelected
                          ? 'bg-muted/50'
                          : 'hover:bg-muted/25',
                      )}
                    >
                      <div
                        className="shrink-0"
                        onClick={(event) => {
                          event.stopPropagation()
                        }}
                      >
                        <Checkbox
                          checked={task.status === 'completed'}
                          disabled={task.status === 'completed' || isCompleting}
                          aria-label={`Complete task ${task.title}`}
                          onCheckedChange={(checked) => {
                            if (checked === true && task.status === 'pending') {
                              void handleQuickComplete(task.id)
                            }
                          }}
                          className="size-4 rounded-full"
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          setSelectedTaskId(task.id)
                          setCompletionError(null)
                          setCommentError(null)
                          setUpdateError(null)
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span
                          className={cn(
                            'truncate text-[13px] font-medium',
                            task.status === 'completed'
                              ? 'text-muted-foreground line-through decoration-muted-foreground/40'
                              : 'text-foreground',
                          )}
                        >
                          {task.title}
                        </span>
                        <div className="mt-0.5 flex items-center gap-2 pl-4 text-[11px] text-muted-foreground/70">
                          <span className="truncate">{managerName}</span>
                          <span className="shrink-0">&middot;</span>
                          <span className="shrink-0">{formatDate(task.createdAt)}</span>
                        </div>
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* ── Mobile overlay ── */}
        {selectedTask ? (
          <button
            type="button"
            className="fixed inset-0 z-20 bg-black/20 backdrop-blur-[1px] md:hidden"
            aria-label="Close task details"
            onClick={() => setSelectedTaskId(null)}
          />
        ) : null}

        {/* ── Detail panel (Linear-style side peek) ── */}
        <aside
          className={cn(
            'fixed inset-y-0 right-0 z-30 w-full max-w-[34rem] border-l border-border/40 bg-background transition-transform duration-150 ease-out md:static md:z-0 md:max-w-none md:overflow-hidden md:transition-[width,transform]',
            selectedTask ? 'translate-x-0 md:w-[28rem]' : 'translate-x-full md:w-0',
          )}
        >
          {selectedTask ? (
            <div className="flex h-full min-h-0 flex-col">
              {/* ── Detail header ── */}
              <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <StatusDot status={selectedTask.status} size="md" />
                    <StatusLabel status={selectedTask.status} />
                    <span className="text-[11px] text-muted-foreground/50">&middot;</span>
                    <span className="truncate text-[11px] text-muted-foreground/70">
                      {managerNameById.get(selectedTask.managerId) ?? selectedTask.managerId}
                    </span>
                  </div>

                  {editingField === 'title' ? (
                    <Input
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onBlur={() => {
                        if (shouldSkipBlurSave('title')) {
                          return
                        }
                        void saveTitle()
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          skipNextBlurSaveRef.current = 'title'
                          void saveTitle()
                          event.currentTarget.blur()
                        }
                        if (event.key === 'Escape') {
                          skipNextBlurSaveRef.current = 'title'
                          setTitleDraft(selectedTask.title)
                          setEditingField(null)
                          setUpdateError(null)
                          event.currentTarget.blur()
                        }
                      }}
                      disabled={updatingField === 'title'}
                      autoFocus
                      className="mt-2 h-auto border-none bg-transparent px-0 py-0 text-lg font-semibold tracking-tight shadow-none outline-none focus-visible:ring-0"
                    />
                  ) : (
                    <button
                      type="button"
                      className="mt-2 w-full text-left"
                      onClick={() => {
                        setTitleDraft(selectedTask.title)
                        setEditingField('title')
                        setUpdateError(null)
                      }}
                    >
                      <h2 className="text-lg font-semibold tracking-tight text-foreground">
                        {selectedTask.title}
                      </h2>
                    </button>
                  )}
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSelectedTaskId(null)}
                  aria-label="Close task details"
                  className="mt-0.5 shrink-0 text-muted-foreground/60 hover:text-foreground"
                >
                  <X className="size-4" />
                </Button>
              </div>

              {/* ── Meta row ── */}
              <div className="flex items-center gap-4 border-t border-border/30 px-5 py-3 text-[12px] text-muted-foreground/70">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays className="size-3" />
                  {formatDateTime(selectedTask.createdAt)}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <UserRound className="size-3" />
                  {managerNameById.get(selectedTask.managerId) ?? selectedTask.managerId}
                </span>
              </div>

              {/* ── Complete action ── */}
              <div className="flex items-center justify-between border-t border-border/30 px-5 py-3">
                <Button
                  type="button"
                  variant={selectedTask.status === 'completed' ? 'ghost' : 'default'}
                  size="sm"
                  className={cn(
                    'h-7 text-xs',
                    selectedTask.status === 'completed' && 'pointer-events-none text-muted-foreground',
                  )}
                  onClick={() => {
                    void handleDetailComplete()
                  }}
                  disabled={selectedTask.status === 'completed' || completingTaskId === selectedTask.id}
                >
                  {selectedTask.status === 'completed'
                    ? 'Completed'
                    : completingTaskId === selectedTask.id
                      ? 'Completing...'
                      : 'Mark complete'}
                </Button>
                {completionError ? <p className="text-[11px] text-destructive">{completionError}</p> : null}
              </div>

              <ScrollArea className="min-h-0 flex-1">
                {/* ── Description ── */}
                <div className="border-t border-border/30 px-5 py-4">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground/50">
                    Description
                  </p>

                  {editingField === 'description' ? (
                    <Textarea
                      value={descriptionDraft}
                      onChange={(event) => setDescriptionDraft(event.target.value)}
                      onBlur={() => {
                        if (shouldSkipBlurSave('description')) {
                          return
                        }
                        void saveDescription()
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          skipNextBlurSaveRef.current = 'description'
                          void saveDescription()
                          event.currentTarget.blur()
                        }
                        if (event.key === 'Escape') {
                          skipNextBlurSaveRef.current = 'description'
                          setDescriptionDraft(selectedTask.description ?? '')
                          setEditingField(null)
                          setUpdateError(null)
                          event.currentTarget.blur()
                        }
                      }}
                      rows={5}
                      disabled={updatingField === 'description'}
                      autoFocus
                      placeholder="Add task details…"
                      className="border-none bg-muted/30 text-sm shadow-none focus-visible:ring-1 focus-visible:ring-border"
                    />
                  ) : (
                    <button
                      type="button"
                      className={cn(
                        'w-full rounded px-2 py-1.5 text-left text-sm transition-colors duration-100 hover:bg-muted/30',
                        !selectedTask.description ? 'text-muted-foreground/50 italic' : 'text-foreground/85',
                      )}
                      onClick={() => {
                        setDescriptionDraft(selectedTask.description ?? '')
                        setEditingField('description')
                        setUpdateError(null)
                      }}
                    >
                      {selectedTask.description?.trim() ? selectedTask.description : 'Add a description…'}
                    </button>
                  )}

                  {updateError ? <p className="mt-2 text-[11px] text-destructive">{updateError}</p> : null}
                </div>

                {/* ── Comments ── */}
                <div className="border-t border-border/30 px-5 py-4">
                  <div className="mb-3 flex items-center gap-2">
                    <MessageSquare className="size-3 text-muted-foreground/50" />
                    <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/50">
                      Activity
                    </p>
                    {selectedTaskComments.length > 0 ? (
                      <span className="text-[11px] tabular-nums text-muted-foreground/40">
                        {selectedTaskComments.length}
                      </span>
                    ) : null}
                  </div>

                  {selectedTaskComments.length > 0 ? (
                    <div className="space-y-3">
                      {selectedTaskComments.map((comment) => (
                        <div key={comment.id} className="group/comment">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'text-[11px] font-medium',
                                comment.type === 'completion'
                                  ? 'text-primary/80'
                                  : 'text-muted-foreground/60',
                              )}
                            >
                              {comment.type === 'completion' ? 'Completed' : 'Comment'}
                            </span>
                            <span className="text-[11px] text-muted-foreground/40">
                              {formatDateTime(comment.createdAt)}
                            </span>
                          </div>
                          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/80">
                            {comment.body}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[12px] text-muted-foreground/50">
                      No activity yet. Add a comment before completing.
                    </p>
                  )}
                </div>
              </ScrollArea>

              {/* ── Add comment ── */}
              <div className="border-t border-border/30 px-5 py-3">
                <div className="flex gap-2">
                  <Textarea
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        void handleAddComment()
                      }
                    }}
                    placeholder="Leave a comment…"
                    rows={2}
                    className="min-h-0 flex-1 resize-none border-none bg-muted/30 text-[13px] shadow-none placeholder:text-muted-foreground/40 focus-visible:ring-1 focus-visible:ring-border"
                    disabled={commentingTaskId === selectedTask.id}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 self-end text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      void handleAddComment()
                    }}
                    disabled={commentingTaskId === selectedTask.id || commentDraft.trim().length === 0}
                  >
                    {commentingTaskId === selectedTask.id ? 'Sending…' : 'Send'}
                  </Button>
                </div>
                {commentError ? <p className="mt-1.5 text-[11px] text-destructive">{commentError}</p> : null}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

/** Small colored status dot — Linear-style */
function StatusDot({ status, size = 'sm' }: { status: UserTask['status']; size?: 'sm' | 'md' }) {
  const dims = size === 'md' ? 'size-2.5' : 'size-2'
  return (
    <span
      className={cn(
        'shrink-0 rounded-full',
        dims,
        status === 'pending'
          ? 'border-[1.5px] border-amber-500/70'
          : 'bg-emerald-500/80',
      )}
      aria-label={status}
    />
  )
}

/** Minimal text label for status */
function StatusLabel({ status }: { status: UserTask['status'] }) {
  return (
    <span
      className={cn(
        'text-[11px] font-medium uppercase tracking-wide',
        status === 'pending' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400',
      )}
    >
      {status === 'pending' ? 'Open' : 'Done'}
    </span>
  )
}

function compareTasks(left: UserTask, right: UserTask): number {
  if (left.status !== right.status) {
    return left.status === 'pending' ? -1 : 1
  }

  if (left.createdAt !== right.createdAt) {
    return right.createdAt.localeCompare(left.createdAt)
  }

  return right.id.localeCompare(left.id)
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}
