import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RootGate } from '../root-gate'

// Cutover (titah 23 Sep): root "/" adalah meja studio Beranda NATIVE —
// shell warisan #56 bukan lagi bawaan. Shell masih datang di panggung dan
// dapat diakses lewat pintu eksplisit (/?guided); cutover mengganti bawaan,
// bukan menghapus sejarah.

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }))

describe('RootGate cutover ke Beranda', () => {
  afterEach(() => {
    cleanup()
    window.history.pushState({}, '', '/')
  })

  it('renders the native Beranda desk at the root path', () => {
    render(<RootGate search="" />)
    expect(document.querySelector('.beranda-desk')).not.toBeNull()
  })

  it('keeps the legacy guided shell reachable via the explicit guided gate', () => {
    render(<RootGate search="?guided" />)
    expect(document.querySelector('.beranda-desk')).toBeNull()
    expect(document.querySelector('.app-shell')).not.toBeNull()
  })
})
