import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import * as store from './store'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Dev-only handle so the browser-driven tests act on the SAME store instance the
// UI is bound to. A dynamic import() from a test context resolves to its own
// module record, which silently exercised a second copy of the state.
// `import.meta.env.DEV` is false in the production build, so this is dropped.
if (import.meta.env.DEV) {
  ;(window as unknown as { __tailor?: typeof store }).__tailor = store
}
