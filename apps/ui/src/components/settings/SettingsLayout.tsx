import { Settings, KeyRound, Blocks, Wrench } from 'lucide-react'
import { ViewHeader } from '@/components/ViewHeader'
import { cn } from '@/lib/utils'

export type SettingsTab = 'general' | 'auth' | 'integrations' | 'skills'

interface NavItem {
  id: SettingsTab
  label: string
  icon: React.ReactNode
}

const NAV_ITEMS: NavItem[] = [
  { id: 'general', label: 'General', icon: <Settings className="size-4" /> },
  { id: 'auth', label: 'Authentication', icon: <KeyRound className="size-4" /> },
  { id: 'integrations', label: 'Integrations', icon: <Blocks className="size-4" /> },
  { id: 'skills', label: 'Skills', icon: <Wrench className="size-4" /> },
]

interface SettingsLayoutProps {
  activeTab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
  onBack?: () => void
  statusBanner?: React.ReactNode
  children: React.ReactNode
}

export function SettingsLayout({
  activeTab,
  onTabChange,
  onBack,
  statusBanner,
  children,
}: SettingsLayoutProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <ViewHeader title="Settings" onBack={onBack} backAriaLabel="Back to chat" />
      {statusBanner}

      {/* Mobile: horizontal scrolling tab bar */}
      <nav className="app-scroll-area flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 bg-card/30 px-2 py-1.5 md:hidden">
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTabChange(item.id)}
              className={cn(
                'flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                'hover:bg-muted/50',
                isActive
                  ? 'bg-muted text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="flex shrink-0">{item.icon}</span>
              <span className="whitespace-nowrap">{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop: left nav */}
        <nav className="hidden w-48 shrink-0 border-r border-border/60 bg-card/30 md:block">
          <div className="flex flex-col gap-0.5 p-2 pt-3">
            {NAV_ITEMS.map((item) => {
              const isActive = activeTab === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onTabChange(item.id)}
                  className={cn(
                    'flex items-center gap-2 px-3 h-8 text-sm rounded-md transition-colors w-full text-left',
                    'hover:bg-muted/50',
                    isActive
                      ? 'bg-muted text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span className="flex shrink-0">{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </button>
              )
            })}
          </div>
        </nav>

        {/* Content area */}
        <div className="app-scroll-area min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-4 pb-[calc(1rem+var(--app-safe-bottom))] md:px-6 md:py-5">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
