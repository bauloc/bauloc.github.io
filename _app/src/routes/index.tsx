import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return <div className="p-8 font-mono text-ink">skeleton ok — v{__APP_VERSION__}</div>
}
