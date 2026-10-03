import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_shell')({
  component: () => <Outlet />,
})
