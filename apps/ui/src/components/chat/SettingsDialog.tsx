import { useState } from 'react'
import { SettingsLayout, type SettingsTab } from '@/components/settings/SettingsLayout'
import { SettingsGeneral } from '@/components/settings/SettingsGeneral'
import { SettingsAuth } from '@/components/settings/SettingsAuth'
import { SettingsIntegrations } from '@/components/settings/SettingsIntegrations'
import { SettingsSkills } from '@/components/settings/SettingsSkills'
import type { AgentDescriptor, SlackStatusEvent, TelegramStatusEvent } from '@middleman/protocol'

interface SettingsPanelProps {
  wsUrl: string
  managers: AgentDescriptor[]
  slackStatus?: SlackStatusEvent | null
  telegramStatus?: TelegramStatusEvent | null
  onBack?: () => void
  statusBanner?: React.ReactNode
}

export function SettingsPanel({
  wsUrl,
  managers,
  slackStatus,
  telegramStatus,
  onBack,
  statusBanner,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  return (
    <SettingsLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onBack={onBack}
      statusBanner={statusBanner}
    >
      {activeTab === 'general' && <SettingsGeneral wsUrl={wsUrl} />}
      {activeTab === 'auth' && <SettingsAuth wsUrl={wsUrl} />}
      {activeTab === 'integrations' && (
        <SettingsIntegrations
          wsUrl={wsUrl}
          managers={managers}
          slackStatus={slackStatus}
          telegramStatus={telegramStatus}
        />
      )}
      {activeTab === 'skills' && <SettingsSkills wsUrl={wsUrl} />}
    </SettingsLayout>
  )
}
