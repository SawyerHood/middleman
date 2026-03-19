import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ContextWindowIndicatorProps {
  usedTokens: number;
  contextWindow: number;
}

const RING_RADIUS = 7;
const RING_STROKE_WIDTH = 1.75;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  }).format(Math.max(0, Math.round(value)));
}

export function ContextWindowIndicator({ usedTokens, contextWindow }: ContextWindowIndicatorProps) {
  if (contextWindow <= 0) return null;

  const fillRatio = usedTokens / contextWindow;
  const clampedFillRatio = Math.min(Math.max(fillRatio, 0), 1);
  const percentFull = Math.min(Math.max(Math.round(fillRatio * 100), 0), 100);
  const progressOffset = RING_CIRCUMFERENCE * (1 - clampedFillRatio);

  const progressColorClass =
    fillRatio >= 0.95
      ? "stroke-red-500"
      : fillRatio >= 0.8
        ? "stroke-amber-500"
        : "stroke-emerald-500";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
            aria-label={`Context window ${percentFull}% full, ${formatTokens(usedTokens)} of ${formatTokens(contextWindow)} tokens used`}
          />
        }
      >
        <svg viewBox="0 0 20 20" className="size-4 -rotate-90" role="img" aria-hidden="true">
          <circle
            cx="10"
            cy="10"
            r={RING_RADIUS}
            strokeWidth={RING_STROKE_WIDTH}
            fill="none"
            className="stroke-muted-foreground/25"
          />
          <circle
            cx="10"
            cy="10"
            r={RING_RADIUS}
            strokeWidth={RING_STROKE_WIDTH}
            strokeLinecap="round"
            fill="none"
            className={progressColorClass}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={progressOffset}
          />
        </svg>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" sideOffset={6} className="px-3 py-2 text-xs">
        <p className="text-muted-foreground">Context window {percentFull}% full</p>
        <p className="font-medium">
          {formatTokens(usedTokens)} / {formatTokens(contextWindow)} tokens used
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
