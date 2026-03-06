import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CheckCircle2, Clock3, ListTodo, PanelLeft } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, UserTask } from '@middleman/protocol'

interface TaskViewProps {
  tasks: UserTask[]
  managers: AgentDescriptor[]
  onBack: () => void
  onCompleteTask: (taskId: string, comment?: string) => Promise<void>
  onToggleMobileSidebar: () => void
}

type TaskGroup = {
  managerId: string
  managerName: string
  tasks: UserTask[]
}

export function TaskView({
  tasks,
  managers,
  onBack,
  onCompleteTask,
  onToggleMobileSidebar,
}: TaskViewProps) {
  const [draftTaskId, setDraftTaskId] = useState<string | null>(null)
  const [draftComment, setDraftComment] = useState('')
  const [submittingTaskId, setSubmittingTaskId] = useState<string | null>(null)
  const [completionError, setCompletionError] = useState<string | null>(null)

  const managerNameById = useMemo(() => {
    return new Map(managers.map((manager) => [manager.agentId, manager.displayName || manager.agentId]))
  }, [managers])

  const groupedTasks = useMemo<TaskGroup[]>(() => {
    const groups = new Map<string, UserTask[]>()

    for (const task of tasks) {
      const existingTasks = groups.get(task.managerId) ?? []
      existingTasks.push(task)
      groups.set(task.managerId, existingTasks)
    }

    return Array.from(groups.entries())
      .map(([managerId, managerTasks]) => ({
        managerId,
        managerName: managerNameById.get(managerId) ?? managerId,
        tasks: managerTasks.sort(compareTasks),
      }))
      .sort((left, right) => left.managerName.localeCompare(right.managerName))
  }, [managerNameById, tasks])

  const pendingCount = tasks.filter((task) => task.status === 'pending').length
  const completedCount = tasks.length - pendingCount

  useEffect(() => {
    if (!draftTaskId) {
      return
    }

    const draftTask = tasks.find((task) => task.id === draftTaskId)
    if (!draftTask || draftTask.status !== 'pending') {
      setDraftTaskId(null)
      setDraftComment('')
      setCompletionError(null)
    }
  }, [draftTaskId, tasks])

  const handleToggleDraft = (taskId: string, nextChecked: boolean) => {
    if (!nextChecked) {
      setDraftTaskId((currentTaskId) => (currentTaskId === taskId ? null : currentTaskId))
      setDraftComment('')
      setCompletionError(null)
      return
    }

    setDraftTaskId(taskId)
    setDraftComment('')
    setCompletionError(null)
  }

  const handleSubmit = async (taskId: string) => {
    setSubmittingTaskId(taskId)
    setCompletionError(null)

    try {
      await onCompleteTask(taskId, draftComment)
      setDraftTaskId(null)
      setDraftComment('')
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : 'Failed to complete task.')
    } finally {
      setSubmittingTaskId((currentTaskId) => (currentTaskId === taskId ? null : currentTaskId))
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
                <h1 className="truncate text-sm font-semibold sm:text-base">User Tasks</h1>
                <Badge variant="outline">{tasks.length}</Badge>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                Pending work assigned across all managers
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className="hidden gap-1 border-emerald-500/30 bg-emerald-500/8 text-emerald-700 sm:inline-flex dark:text-emerald-300"
          >
            <Clock3 className="size-3" />
            {pendingCount} pending
          </Badge>
          <Badge
            variant="outline"
            className="hidden gap-1 border-sky-500/30 bg-sky-500/8 text-sky-700 sm:inline-flex dark:text-sky-300"
          >
            <CheckCircle2 className="size-3" />
            {completedCount} completed
          </Badge>
          <Button type="button" variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="size-3.5" />
            Back to Chat
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-5 sm:px-6">
          {tasks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 px-6 py-12 text-center">
              <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl border border-border/70 bg-background shadow-sm">
                <ListTodo className="size-5 text-muted-foreground" />
              </div>
              <h2 className="text-base font-semibold">No assigned tasks</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Tasks created by managers will appear here in real time.
              </p>
            </div>
          ) : (
            groupedTasks.map((group, index) => (
              <section key={group.managerId} className="space-y-3">
                {index > 0 ? <Separator className="mb-2" /> : null}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">{group.managerName}</h2>
                    <p className="text-xs text-muted-foreground">{group.managerId}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{group.tasks.length} total</Badge>
                    <Badge
                      variant="outline"
                      className="border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300"
                    >
                      {group.tasks.filter((task) => task.status === 'pending').length} pending
                    </Badge>
                  </div>
                </div>

                <div className="space-y-3">
                  {group.tasks.map((task) => {
                    const isPending = task.status === 'pending'
                    const isDraftOpen = draftTaskId === task.id
                    const isSubmitting = submittingTaskId === task.id

                    return (
                      <article
                        key={task.id}
                        className={cn(
                          'rounded-2xl border px-4 py-4 shadow-sm transition-colors sm:px-5',
                          isPending
                            ? 'border-border/70 bg-background'
                            : 'border-border/60 bg-muted/20',
                        )}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-sm font-semibold text-foreground">{task.title}</h3>
                              <Badge
                                variant="outline"
                                className={cn(
                                  task.status === 'pending'
                                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                                    : 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
                                )}
                              >
                                {task.status}
                              </Badge>
                            </div>
                            {task.description ? (
                              <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                                {task.description}
                              </p>
                            ) : null}
                          </div>

                          <div className="shrink-0 text-right text-xs text-muted-foreground">
                            <p>Created {formatTimestamp(task.createdAt)}</p>
                            {task.completedAt ? <p className="mt-1">Completed {formatTimestamp(task.completedAt)}</p> : null}
                          </div>
                        </div>

                        {task.status === 'completed' && task.completionComment ? (
                          <div className="mt-4 rounded-xl border border-border/60 bg-background/80 px-3 py-2.5">
                            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                              Completion note
                            </p>
                            <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/90">
                              {task.completionComment}
                            </p>
                          </div>
                        ) : null}

                        {isPending ? (
                          <div className="mt-4 rounded-xl border border-border/60 bg-muted/20 px-3 py-3">
                            <div className="flex items-start gap-3">
                              <Checkbox
                                checked={isDraftOpen}
                                onCheckedChange={(checked) => handleToggleDraft(task.id, checked === true)}
                                disabled={isSubmitting}
                                aria-label={`Mark task ${task.title} complete`}
                              />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-foreground">Mark complete</p>
                                <p className="text-xs text-muted-foreground">
                                  Send a completion update back to {group.managerName}. A comment is optional.
                                </p>
                              </div>
                            </div>

                            {isDraftOpen ? (
                              <div className="mt-3 space-y-3">
                                <div className="space-y-2">
                                  <Label htmlFor={`task-comment-${task.id}`}>Optional comment</Label>
                                  <Textarea
                                    id={`task-comment-${task.id}`}
                                    value={draftComment}
                                    onChange={(event) => setDraftComment(event.target.value)}
                                    placeholder="Add context, blockers, or what you finished."
                                    rows={3}
                                    disabled={isSubmitting}
                                  />
                                </div>

                                {completionError ? (
                                  <p className="text-xs text-destructive">{completionError}</p>
                                ) : null}

                                <div className="flex flex-wrap justify-end gap-2">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleToggleDraft(task.id, false)}
                                    disabled={isSubmitting}
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    onClick={() => {
                                      void handleSubmit(task.id)
                                    }}
                                    disabled={isSubmitting}
                                  >
                                    {isSubmitting ? 'Completing...' : 'Complete task'}
                                  </Button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                    )
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
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

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}
