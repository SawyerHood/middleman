import { Button } from "@/components/ui/button";

const suggestions = ["Plan a middleman workflow", "Debug manager state", "Summarize latest run"];

export function EmptyState({
  activeAgentId,
  onSuggestionClick,
}: {
  activeAgentId?: string | null;
  onSuggestionClick?: (suggestion: string) => void;
}) {
  if (!activeAgentId) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <h2 className="mb-2 text-base font-medium text-foreground">No manager selected</h2>
        <p className="text-sm text-muted-foreground">
          Create a manager from the sidebar to start a thread.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center">
      <h2 className="mb-4 text-base font-medium text-foreground">What can I do for you?</h2>
      {onSuggestionClick ? (
        <div className="flex max-w-[320px] flex-wrap justify-center gap-2">
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion}
              onClick={() => onSuggestionClick(suggestion)}
              type="button"
              variant="outline"
              className="h-auto rounded-full bg-muted px-3 py-1.5 text-sm font-normal text-foreground transition-colors hover:bg-muted/80"
            >
              {suggestion}
            </Button>
          ))}
        </div>
      ) : null}
      <p className="mt-6 text-xs text-muted-foreground">
        AI can make mistakes. Always verify important actions.
      </p>
    </div>
  );
}
