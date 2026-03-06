import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CalendarDays, ListTodo, PanelLeft, UserRound, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
      <div className="flex h-[62px] shrink-0 items-center justify-between border-b border-border px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
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
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-muted/40">
              <ListTodo className="size-4 text-foreground/80" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-sm font-semibold sm:text-base">Tasks</h1>
                <Badge variant="outline">{sortedTasks.length}</Badge>
              </div>
              <p className="truncate text-xs text-muted-foreground">Assigned work across managers</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className="hidden border-emerald-500/30 bg-emerald-500/8 text-emerald-700 sm:inline-flex dark:text-emerald-300"
          >
            {pendingCount} pending
          </Badge>
          <Button type="button" variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="size-3.5" />
            Back to Chat
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-foreground">Assigned tasks</p>
              <p className="text-xs text-muted-foreground">
                Open a task for details or use the checkbox to complete it immediately.
              </p>
            </div>
            <Badge variant="outline">{pendingCount} open</Badge>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            {sortedTasks.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl border border-border/70 bg-muted/30">
                  <ListTodo className="size-5 text-muted-foreground" />
                </div>
                <h2 className="text-base font-semibold">No tasks assigned yet</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Tasks assigned by managers will show up here in real time.
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
                        'flex items-center gap-3 border-b border-border/70 px-4 py-3 transition-colors last:border-b-0',
                        isSelected ? 'bg-muted/35' : 'hover:bg-muted/20',
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
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">{task.title}</span>
                          <TaskStatusBadge status={task.status} />
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{managerName}</span>
                          <span>{formatDate(task.createdAt)}</span>
                        </div>
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </ScrollArea>
        </div>

        {selectedTask ? (
          <button
            type="button"
            className="fixed inset-0 z-20 bg-black/20 md:hidden"
            aria-label="Close task details"
            onClick={() => setSelectedTaskId(null)}
          />
        ) : null}

        <aside
          className={cn(
            'fixed inset-y-0 right-0 z-30 w-full max-w-[34rem] border-l border-border/80 bg-background shadow-[-24px_0_48px_-36px_rgba(15,23,42,0.45)] transition-transform duration-200 md:static md:z-0 md:max-w-none md:overflow-hidden md:transition-[width,transform]',
            selectedTask ? 'translate-x-0 md:w-[30rem]' : 'translate-x-full md:w-0',
          )}
        >
          {selectedTask ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex items-start justify-between gap-4 border-b border-border/70 px-4 py-4">
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <TaskStatusBadge status={selectedTask.status} />
                    <Badge variant="outline">{managerNameById.get(selectedTask.managerId) ?? selectedTask.managerId}</Badge>
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
                      className="h-11 border-transparent bg-transparent px-0 text-xl font-semibold shadow-none focus-visible:border-input focus-visible:bg-background"
                    />
                  ) : (
                    <button
                      type="button"
                      className="w-full text-left"
                      onClick={() => {
                        setTitleDraft(selectedTask.title)
                        setEditingField('title')
                        setUpdateError(null)
                      }}
                    >
                      <h2 className="text-xl font-semibold tracking-tight text-foreground">
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
                >
                  <X className="size-4" />
                </Button>
              </div>

              <div className="border-b border-border/70 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <UserRound className="size-3.5" />
                    {managerNameById.get(selectedTask.managerId) ?? selectedTask.managerId}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays className="size-3.5" />
                    Created {formatDateTime(selectedTask.createdAt)}
                  </span>
                </div>

                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    variant={selectedTask.status === 'completed' ? 'secondary' : 'default'}
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
                </div>

                {completionError ? <p className="mt-2 text-xs text-destructive">{completionError}</p> : null}
              </div>

              <ScrollArea className="min-h-0 flex-1">
                <div className="border-b border-border/70 px-4 py-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Description
                  </p>

                  <div className="mt-3">
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
                        rows={6}
                        disabled={updatingField === 'description'}
                        autoFocus
                        placeholder="Add task details"
                      />
                    ) : (
                      <button
                        type="button"
                        className={cn(
                          'w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted/20',
                          !selectedTask.description ? 'text-muted-foreground' : 'text-foreground',
                        )}
                        onClick={() => {
                          setDescriptionDraft(selectedTask.description ?? '')
                          setEditingField('description')
                          setUpdateError(null)
                        }}
                      >
                        {selectedTask.description?.trim() ? selectedTask.description : 'Add a description'}
                      </button>
                    )}
                  </div>

                  {updateError ? <p className="mt-2 text-xs text-destructive">{updateError}</p> : null}
                </div>

                <div className="px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Comments
                    </p>
                    <span className="text-xs text-muted-foreground">
                      {selectedTaskComments.length} {selectedTaskComments.length === 1 ? 'entry' : 'entries'}
                    </span>
                  </div>

                  {selectedTaskComments.length > 0 ? (
                    <div className="mt-4 space-y-4">
                      {selectedTaskComments.map((comment) => (
                        <div key={comment.id} className="border-b border-border/60 pb-4 last:border-b-0 last:pb-0">
                          <div className="flex items-center justify-between gap-3">
                            <Badge variant="outline" className="capitalize">
                              {comment.type === 'completion' ? 'Completed' : 'Comment'}
                            </Badge>
                            <p className="text-xs text-muted-foreground">{formatDateTime(comment.createdAt)}</p>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">
                            {comment.body}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">
                      Leave a comment before completing the task if you want the manager to review it.
                    </p>
                  )}
                </div>
              </ScrollArea>

              <div className="border-t border-border/70 px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Add comment
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedTask.status === 'completed'
                    ? 'Manager has already been notified that this task is complete.'
                    : 'When you complete this task, the manager will be told to check task comments for details.'}
                </p>

                <Textarea
                  value={commentDraft}
                  onChange={(event) => setCommentDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void handleAddComment()
                    }
                  }}
                  placeholder="Leave a note for the manager."
                  rows={4}
                  className="mt-3"
                  disabled={commentingTaskId === selectedTask.id}
                />

                {commentError ? <p className="mt-2 text-xs text-destructive">{commentError}</p> : null}

                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      void handleAddComment()
                    }}
                    disabled={commentingTaskId === selectedTask.id || commentDraft.trim().length === 0}
                  >
                    {commentingTaskId === selectedTask.id ? 'Sending...' : 'Send comment'}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

function TaskStatusBadge({ status }: { status: UserTask['status'] }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        status === 'pending'
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
          : 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
      )}
    >
      {status}
    </Badge>
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
