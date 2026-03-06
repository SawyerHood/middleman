import { useEffect } from 'react'
import { Provider as JotaiProvider } from 'jotai'
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { ReactGrabBootstrap } from '@/components/dev/ReactGrabBootstrap'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createEmojiSvgFaviconHref, DEFAULT_FAVICON_EMOJI } from '@/lib/favicon'
import { THEME_INIT_SCRIPT, initializeThemePreference } from '@/lib/theme'
import { IndexPage } from './index'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Middleman Manager UI',
      },
    ],
    links: [
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: createEmojiSvgFaviconHref(DEFAULT_FAVICON_EMOJI),
      },
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  notFoundComponent: IndexPage,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    initializeThemePreference()
  }, [])

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="overflow-x-hidden">
        <JotaiProvider>
          <TooltipProvider>
            {children}
            <ReactGrabBootstrap />
            <TanStackDevtools
              config={{
                position: 'bottom-right',
              }}
              plugins={[
                {
                  name: 'Tanstack Router',
                  render: <TanStackRouterDevtoolsPanel />,
                },
              ]}
            />
          </TooltipProvider>
        </JotaiProvider>
        <Scripts />
      </body>
    </html>
  )
}
