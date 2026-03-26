import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";
import { StoreProvider } from "./store";

type RouterHistory = NonNullable<Parameters<typeof createRouter>[0]["history"]>;

export function getRouter(history: RouterHistory) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Retry failed queries (backend may not be ready on first load)
        retry: 3,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
        // Refetch on window focus to pick up missed updates
        refetchOnWindowFocus: true,
      },
    },
  });

  return createRouter({
    routeTree,
    history,
    context: {
      queryClient,
    },
    Wrap: ({ children }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(StoreProvider, null, children),
      ),
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
