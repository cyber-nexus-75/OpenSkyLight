import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { installWebBridge, onWebBridgeReconnect } from './webBridge'
import './styles/global.css'

// Inside Electron the preload script provides window.osl; in a browser
// (server mode) this installs the HTTP/SSE bridge instead.
installWebBridge()

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
})

onWebBridgeReconnect(() => {
  void queryClient.invalidateQueries()
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
