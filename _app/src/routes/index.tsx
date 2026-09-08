import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return <div className="text-foreground p-8 font-mono">skeleton ok — v{__APP_VERSION__}</div>
}
