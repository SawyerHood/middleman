import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function SettingsSection({
  label,
  description,
  children,
  cta,
}: {
  label: string;
  description?: string | React.ReactNode;
  children: React.ReactNode;
  cta?: React.ReactNode;
}) {
  return (
    <div className="space-y-4 pb-4">
      <div className="flex flex-col gap-3 border-b pb-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex-1">
          <h3 className="text-base font-semibold">{label}</h3>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {cta && <div className="flex-shrink-0">{cta}</div>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

export function SettingsWithCTA({
  label,
  description,
  children,
  direction = "row",
}: {
  label: string;
  description?: string | React.ReactNode;
  children: React.ReactNode;
  direction?: "row" | "col";
}) {
  return (
    <div
      className={cn("flex items-start justify-between gap-4 rounded-md px-2 -mx-2", {
        "flex-col gap-2": direction === "col",
        "flex-col sm:flex-row gap-4": direction === "row",
      })}
    >
      <div className="flex flex-col gap-1 flex-1">
        <Label className="text-sm font-semibold">{label}</Label>
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </div>
      {children}
    </div>
  );
}
