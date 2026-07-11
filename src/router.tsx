import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { RouteFallback, RouteError } from "./components/route-fallbacks";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Retry transient failures (e.g. a read that races DB replication
        // right after an insert) instead of surfacing a broken screen.
        retry: 2,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
        staleTime: 30_000,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Preload a route's code + data as soon as the user hovers/touches a link
    // so pages like "Add sensor" open instantly instead of lazy-loading on click.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    // Always render something during navigation / on error instead of a blank
    // or half-loaded page (which showed up as "page didn't load properly").
    defaultPendingComponent: RouteFallback,
    defaultErrorComponent: RouteError,
  });

  return router;
};
