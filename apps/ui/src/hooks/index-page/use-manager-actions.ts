import {
  useCallback,
  useState,
  type Dispatch,
  type FormEvent,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import type {
  AgentDescriptor,
  ManagerModelPreset,
} from '@middleman/protocol'
import type { AppRouteState } from './use-route-state'

interface UseManagerActionsOptions {
  clientRef: MutableRefObject<ManagerWsClient | null>
  agents: AgentDescriptor[]
  activeAgent: AgentDescriptor | null
  defaultManagerModel: ManagerModelPreset
  navigateToRoute: (nextRouteState: AppRouteState, replace?: boolean) => void
  setState: Dispatch<SetStateAction<ManagerWsState>>
  clearPendingResponseForAgent: (agentId: string) => void
}

export function useManagerActions({
  clientRef,
  agents,
  activeAgent,
  defaultManagerModel,
  navigateToRoute,
  setState,
  clearPendingResponseForAgent,
}: UseManagerActionsOptions): {
  isCreateManagerDialogOpen: boolean
  newManagerName: string
  newManagerCwd: string
  newManagerModel: ManagerModelPreset
  createManagerError: string | null
  browseError: string | null
  isCreatingManager: boolean
  isValidatingDirectory: boolean
  isPickingDirectory: boolean
  handleNewManagerNameChange: (value: string) => void
  handleNewManagerCwdChange: (value: string) => void
  handleNewManagerModelChange: (value: ManagerModelPreset) => void
  handleOpenCreateManagerDialog: () => void
  handleCreateManagerDialogOpenChange: (open: boolean) => void
  handleBrowseDirectory: () => Promise<void>
  handleCreateManager: (event: FormEvent<HTMLFormElement>) => Promise<void>
  managerToDelete: AgentDescriptor | null
  deleteManagerError: string | null
  isDeletingManager: boolean
  handleRequestDeleteManager: (managerId: string) => void
  handleConfirmDeleteManager: () => Promise<void>
  handleCloseDeleteManagerDialog: () => void
  isStoppingAllAgents: boolean
  handleStopAllAgents: () => Promise<void>
} {
  const [isCreateManagerDialogOpen, setIsCreateManagerDialogOpen] = useState(false)
  const [newManagerName, setNewManagerName] = useState('')
  const [newManagerCwd, setNewManagerCwd] = useState('')
  const [newManagerModel, setNewManagerModel] = useState<ManagerModelPreset>(defaultManagerModel)
  const [createManagerError, setCreateManagerError] = useState<string | null>(null)
  const [isCreatingManager, setIsCreatingManager] = useState(false)
  const [isValidatingDirectory, setIsValidatingDirectory] = useState(false)

  const [browseError, setBrowseError] = useState<string | null>(null)
  const [isPickingDirectory, setIsPickingDirectory] = useState(false)

  const [managerToDelete, setManagerToDelete] = useState<AgentDescriptor | null>(null)
  const [deleteManagerError, setDeleteManagerError] = useState<string | null>(null)
  const [isDeletingManager, setIsDeletingManager] = useState(false)

  const [isStoppingAllAgents, setIsStoppingAllAgents] = useState(false)

  const handleNewManagerNameChange = useCallback((value: string) => {
    setNewManagerName(value)
  }, [])

  const handleNewManagerCwdChange = useCallback((value: string) => {
    setNewManagerCwd(value)
    setCreateManagerError(null)
  }, [])

  const handleNewManagerModelChange = useCallback((value: ManagerModelPreset) => {
    setNewManagerModel(value)
    setCreateManagerError(null)
  }, [])

  const handleStopAllAgents = useCallback(async () => {
    const client = clientRef.current
    if (!client || activeAgent?.role !== 'manager') {
      return
    }

    setIsStoppingAllAgents(true)

    try {
      await client.stopAllAgents(activeAgent.agentId)
      clearPendingResponseForAgent(activeAgent.agentId)
      setState((previous) => ({
        ...previous,
        lastError: null,
      }))
    } catch (error) {
      setState((previous) => ({
        ...previous,
        lastError: `Failed to stop manager and workers: ${toErrorMessage(error)}`,
      }))
    } finally {
      setIsStoppingAllAgents(false)
    }
  }, [activeAgent, clearPendingResponseForAgent, clientRef, setState])

  const handleOpenCreateManagerDialog = useCallback(() => {
    const defaultCwd =
      activeAgent?.cwd ??
      agents.find((agent) => agent.role === 'manager')?.cwd ??
      ''

    setNewManagerName('')
    setNewManagerCwd(defaultCwd)
    setNewManagerModel(defaultManagerModel)
    setBrowseError(null)
    setCreateManagerError(null)
    setIsCreateManagerDialogOpen(true)
  }, [activeAgent, agents, defaultManagerModel])

  const handleCreateManagerDialogOpenChange = useCallback((open: boolean) => {
    if (!open && isCreatingManager) {
      return
    }

    setIsCreateManagerDialogOpen(open)
  }, [isCreatingManager])

  const handleBrowseDirectory = useCallback(async () => {
    const client = clientRef.current
    if (!client) {
      return
    }

    setBrowseError(null)
    setIsPickingDirectory(true)

    try {
      const pickedPath = await client.pickDirectory(newManagerCwd)
      if (!pickedPath) {
        return
      }

      setNewManagerCwd(pickedPath)
      setCreateManagerError(null)
    } catch (error) {
      setBrowseError(toErrorMessage(error))
    } finally {
      setIsPickingDirectory(false)
    }
  }, [clientRef, newManagerCwd])

  const handleCreateManager = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const client = clientRef.current
    if (!client) {
      return
    }

    const name = newManagerName.trim()
    const cwd = newManagerCwd.trim()

    if (!name) {
      setCreateManagerError('Manager name is required.')
      return
    }

    if (!cwd) {
      setCreateManagerError('Manager working directory is required.')
      return
    }

    setCreateManagerError(null)
    setIsCreatingManager(true)

    try {
      setIsValidatingDirectory(true)
      const validation = await client.validateDirectory(cwd)
      setIsValidatingDirectory(false)

      if (!validation.valid) {
        setCreateManagerError(validation.message ?? 'Directory is not valid.')
        return
      }

      const manager = await client.createManager({
        name,
        cwd: validation.path || cwd,
        model: newManagerModel,
      })

      navigateToRoute({ view: 'chat', agentId: manager.agentId })
      client.subscribeToAgent(manager.agentId)

      setIsCreateManagerDialogOpen(false)
      setNewManagerName('')
      setNewManagerCwd('')
      setNewManagerModel(defaultManagerModel)
      setBrowseError(null)
      setCreateManagerError(null)
    } catch (error) {
      setCreateManagerError(toErrorMessage(error))
    } finally {
      setIsValidatingDirectory(false)
      setIsCreatingManager(false)
    }
  }, [
    clientRef,
    defaultManagerModel,
    navigateToRoute,
    newManagerCwd,
    newManagerModel,
    newManagerName,
  ])

  const handleRequestDeleteManager = useCallback((managerId: string) => {
    const manager = agents.find(
      (agent) => agent.agentId === managerId && agent.role === 'manager',
    )
    if (!manager) {
      return
    }

    setDeleteManagerError(null)
    setManagerToDelete(manager)
  }, [agents])

  const handleConfirmDeleteManager = useCallback(async () => {
    const manager = managerToDelete
    const client = clientRef.current
    if (!manager || !client) {
      return
    }

    setDeleteManagerError(null)
    setIsDeletingManager(true)

    try {
      await client.deleteManager(manager.agentId)

      setManagerToDelete(null)
      setDeleteManagerError(null)
    } catch (error) {
      setDeleteManagerError(toErrorMessage(error))
    } finally {
      setIsDeletingManager(false)
    }
  }, [clientRef, managerToDelete])

  const handleCloseDeleteManagerDialog = useCallback(() => {
    if (isDeletingManager) {
      return
    }

    setManagerToDelete(null)
    setDeleteManagerError(null)
  }, [isDeletingManager])

  return {
    isCreateManagerDialogOpen,
    newManagerName,
    newManagerCwd,
    newManagerModel,
    createManagerError,
    browseError,
    isCreatingManager,
    isValidatingDirectory,
    isPickingDirectory,
    handleNewManagerNameChange,
    handleNewManagerCwdChange,
    handleNewManagerModelChange,
    handleOpenCreateManagerDialog,
    handleCreateManagerDialogOpenChange,
    handleBrowseDirectory,
    handleCreateManager,
    managerToDelete,
    deleteManagerError,
    isDeletingManager,
    handleRequestDeleteManager,
    handleConfirmDeleteManager,
    handleCloseDeleteManagerDialog,
    isStoppingAllAgents,
    handleStopAllAgents,
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'An unexpected error occurred.'
}
