import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { App } from './App'

describe('App', () => {
  it('renders the honest scaffold without product actions', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Gandiwa Studio' })).toBeVisible()
    expect(screen.getByText('Application foundation')).toBeVisible()
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument()
  })
})
