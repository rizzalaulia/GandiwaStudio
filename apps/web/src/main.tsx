import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { RootGate } from './root-gate'
import './styles.css'
import './beranda/beranda.css'

const root = document.getElementById('root')

if (root === null) {
  throw new Error('Missing #root element')
}

createRoot(root).render(
  <StrictMode>
    <RootGate />
  </StrictMode>,
)
