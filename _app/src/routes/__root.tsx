import { Navigate, Outlet, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => <Outlet />,
  /*
    An address the site has no page for opens the profile. GitHub Pages answers it with
    404.html, a copy of the app, so it is the router that finds the page missing; the address
    is replaced, so Back skips it. Pages' answer itself stays a 404, so a link checker still
    sees the link as broken.

    Nested addresses (/profile/nope, /xconsole/nope) come here too: a not-found goes to the
    nearest route with a notFoundComponent, and this is the only one.
  */
  notFoundComponent: () => <Navigate to="/profile" replace />,
})
