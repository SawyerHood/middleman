import { useState } from 'react'
import { SettingsLayout, type SettingsTab } from '@/components/settings/SettingsLayout'
import { SettingsGeneral } from '@/components/settings/SettingsGeneral'
import { SettingsAuth } from '@/components/settings/SettingsAuth'
import { SettingsSkills } from '@/components/settings/SettingsSkills'

interface SettingsPanelProps {
  wsUrl: string
  onBack?: () => void
  statusBanner?: React.ReactNode
}

export function SettingsPanel({
  wsUrl,
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
      {activeTab === 'skills' && <SettingsSkills wsUrl={wsUrl} />}
    </SettingsLayout>
  )
}
