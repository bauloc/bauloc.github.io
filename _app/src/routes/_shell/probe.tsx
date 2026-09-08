import { createFileRoute } from '@tanstack/react-router'

/*
  Temporary. Exists only so `_shell` is a real pathless layout with a child, which is what
  makes the leading-underscore chunk appear — the exact filename Jekyll would drop. Once
  /xconsole/* moves under _shell in stage 3 this file goes away.
*/
export const Route = createFileRoute('/_shell/probe')({
  component: () => <div className="p-8">probe</div>,
})
