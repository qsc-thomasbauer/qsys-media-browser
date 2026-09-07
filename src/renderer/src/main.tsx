/**
 * Renderer entry point.
 *
 * The theme is applied *before* React's first render, so the customer's palette
 * is on screen from the first painted frame rather than flashing a default.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { applyTheme } from './lib/theme'
import { App } from './App'
import { config } from './lib/api'
import './styles.css'

applyTheme(config.theme, document.documentElement)
document.title = config.productName

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The Core is on the local network and this is a desktop app: refetching
      // on focus is cheap and means a second operator's changes show up when
      // the window is brought forward.
      refetchOnWindowFocus: true,
      retry: 1,
      staleTime: 10_000
    },
    mutations: {
      retry: 0
    }
  }
})

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
)
