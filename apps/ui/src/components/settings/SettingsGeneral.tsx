import { useCallback, useEffect, useState } from "react";
import { Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { SettingsSection, SettingsWithCTA } from "./settings-row";
import { applyThemePreference, readStoredThemePreference, type ThemePreference } from "@/lib/theme";
import { resolveApiEndpoint } from "@/lib/api-endpoint";

interface SettingsGeneralProps {
  wsUrl: string;
}

export function SettingsGeneral({ wsUrl }: SettingsGeneralProps) {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readStoredThemePreference(),
  );

  useEffect(() => {
    setThemePreference(readStoredThemePreference());
  }, []);

  const handleThemePreferenceChange = useCallback((nextPreference: ThemePreference) => {
    setThemePreference(nextPreference);
    applyThemePreference(nextPreference);
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection label="Appearance" description="Customize how the app looks">
        <SettingsWithCTA label="Theme" description="Choose between light, dark, or system theme">
          <Select
            value={themePreference}
            onValueChange={(value) => {
              if (value === "light" || value === "dark" || value === "auto") {
                handleThemePreferenceChange(value);
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder="Select theme" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">
                <span className="inline-flex items-center gap-2">
                  <Sun className="size-3.5" />
                  Light
                </span>
              </SelectItem>
              <SelectItem value="dark">
                <span className="inline-flex items-center gap-2">
                  <Moon className="size-3.5" />
                  Dark
                </span>
              </SelectItem>
              <SelectItem value="auto">
                <span className="inline-flex items-center gap-2">
                  <Monitor className="size-3.5" />
                  System
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingsWithCTA>
      </SettingsSection>

      <SettingsSection label="System" description="Manage the Middleman daemon">
        <SettingsWithCTA label="Reboot" description="Restart the Middleman daemon and all agents">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const endpoint = resolveApiEndpoint(wsUrl, "/api/reboot");
              void fetch(endpoint, { method: "POST" }).catch(() => {});
            }}
          >
            <RotateCcw className="size-3.5 mr-1.5" />
            Reboot
          </Button>
        </SettingsWithCTA>
      </SettingsSection>
    </div>
  );
}
