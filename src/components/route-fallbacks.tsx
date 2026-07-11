// Shared fallback UIs used by the router for pending navigations and errors.
// Kept in a components-only module so React Fast Refresh stays happy.

export function RouteFallback() {
  return (
    <div
      className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <p className="text-sm">Loading…</p>
    </div>
  );
}

export function RouteError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div>
        <p className="text-lg font-semibold">This page didn’t load properly</p>
        <p className="mt-1 text-sm text-muted-foreground">
          A temporary hiccup — this usually clears right away.
        </p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => reset()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-transform hover:opacity-90 active:scale-[0.98]"
        >
          Try again
        </button>
        <button
          onClick={() => window.location.reload()}
          className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
