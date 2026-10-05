import { Outlet, createRootRoute } from '@tanstack/react-router'

import { NotFoundPage } from '@/features/home/not-found-page'

export const Route = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: NotFoundPage,
})
