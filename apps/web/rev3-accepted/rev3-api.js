(() => {
  'use strict'

  const $ = (selector) => document.querySelector(selector)
  const endpoint = '/api/v1/settings/providers'

  const text = {
    missing: 'No key stored in Gandiwa backend.',
    stored: (masked) => `Stored in Gandiwa backend (${masked}).`,
    saving: 'Saving encrypted key in Gandiwa backend…',
    saved: 'Key saved in Gandiwa backend. Check connection now verifies the provider without generating an image.',
    noKey: 'Save a provider key first, then run Check connection.',
    valid: 'Key valid. The provider accepted authentication.',
    locked: 'Key valid, but the provider account is locked or out of credit. Resolve billing at the provider dashboard; do not paste the key again.',
    rejected: 'Key rejected by the provider. Check the key and paste it again.',
    unreachable: 'Provider cannot be reached, so key validity cannot be confirmed.',
    error: 'Backend connection failed. No key was changed.',
    openai: 'OpenAI Image connector is not available in Gandiwa backend yet. This selection is locked and no key is sent.',
  }

  async function asJson(response) {
    const raw = await response.text()
    try { return raw ? JSON.parse(raw) : {} } catch { return {} }
  }

  async function csrfToken() {
    const response = await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })
    const body = await asJson(response)
    if (!response.ok || typeof body.csrf_token !== 'string' || !body.csrf_token) throw new Error(text.error)
    return body.csrf_token
  }

  async function providerState() {
    const response = await fetch(endpoint, { credentials: 'same-origin' })
    const body = await asJson(response)
    if (!response.ok || !Array.isArray(body)) throw new Error(text.error)
    return body
  }

  async function save(provider, key) {
    const token = await csrfToken()
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Companion-Token': token },
      body: JSON.stringify({ providers: [{ provider, apiKey: key }] }),
    })
    if (!response.ok) throw new Error(text.error)
  }

  async function validate(provider) {
    const response = await fetch(`${endpoint}/${encodeURIComponent(provider)}/validate`, { credentials: 'same-origin' })
    const body = await asJson(response)
    if (!response.ok) throw new Error(text.error)
    if (body.ok === true) return text.valid
    if (body.reason === 'account_locked' && body.authenticated === true) return text.locked
    if (body.reason === 'auth_rejected') return text.rejected
    return text.unreachable
  }

  function statusFor(provider, state) {
    const item = state.find((entry) => entry && entry.provider === provider)
    return item && item.configured === true ? text.stored(item.maskedKey || 'masked') : text.missing
  }

  function setFeedback(selector, message, ok = false) {
    const node = $(selector)
    if (!node) return
    node.className = `connection-feedback${ok ? ' ok' : ''}`
    node.textContent = message
  }

  function appendSaveButton(buttonId, label) {
    const check = $(`#${buttonId}`)
    if (!check || $(`#save-${buttonId}`)) return
    const button = document.createElement('button')
    button.type = 'button'
    button.id = `save-${buttonId}`
    button.className = 'connection-check'
    button.textContent = label
    check.insertAdjacentElement('beforebegin', button)
  }

  function lockOpenAi() {
    const type = $('#generator-type')
    if (!type || type.value !== 'openai') return false
    setFeedback('#connection-feedback', text.openai)
    return true
  }

  async function refresh() {
    const state = await providerState()
    setFeedback('#connection-feedback', statusFor('fal', state), true)
    setFeedback('#reasoning-connection-feedback', statusFor('9router', state), true)
  }

  function bindImage() {
    const check = $('#check-connection')
    const key = $('#api-key')
    appendSaveButton('check-connection', 'Save key')
    $('#generator-type')?.addEventListener('change', () => { if ($('#generator-type').value === 'openai') lockOpenAi() })
    $('#save-check-connection')?.addEventListener('click', async () => {
      if ($('#generator-type')?.value === 'openai') return void lockOpenAi()
      if (!key?.value.trim()) return setFeedback('#connection-feedback', 'Enter a fal.ai API key before saving.')
      setFeedback('#connection-feedback', text.saving)
      try { await save('fal', key.value.trim()); key.value = ''; await refresh(); setFeedback('#connection-feedback', text.saved, true) }
      catch { setFeedback('#connection-feedback', text.error) }
    })
    check?.addEventListener('click', async (event) => {
      event.stopImmediatePropagation()
      if ($('#generator-type')?.value === 'openai') return void lockOpenAi()
      setFeedback('#connection-feedback', 'Checking fal.ai without creating an image…')
      try { setFeedback('#connection-feedback', await validate('fal'), true) }
      catch { setFeedback('#connection-feedback', text.error) }
    }, true)
  }

  function bindReasoning() {
    const check = $('#check-reasoning-connection')
    const key = $('#reasoning-key')
    appendSaveButton('check-reasoning-connection', 'Save key')
    $('#save-check-reasoning-connection')?.addEventListener('click', async () => {
      if (!key?.value.trim()) return setFeedback('#reasoning-connection-feedback', 'Enter a 9Router API key before saving.')
      setFeedback('#reasoning-connection-feedback', text.saving)
      try { await save('9router', key.value.trim()); key.value = ''; await refresh(); setFeedback('#reasoning-connection-feedback', text.saved, true) }
      catch { setFeedback('#reasoning-connection-feedback', text.error) }
    })
    check?.addEventListener('click', async (event) => {
      event.stopImmediatePropagation()
      setFeedback('#reasoning-connection-feedback', 'Checking 9Router without sending a prompt…')
      try { setFeedback('#reasoning-connection-feedback', await validate('9router'), true) }
      catch { setFeedback('#reasoning-connection-feedback', text.error) }
    }, true)
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindImage()
    bindReasoning()
    const instance = $('#reasoning-instance')
    const model = $('#reasoning-model')
    const saved = JSON.parse(localStorage.getItem('gandiwa-rev3-assistant') || '{}')
    if (instance && typeof saved.instance_id === 'string') instance.value = saved.instance_id
    if (model && typeof saved.model_id === 'string') model.value = saved.model_id
    const rememberAssistant = () => localStorage.setItem('gandiwa-rev3-assistant', JSON.stringify({
      instance_id: instance?.value || '', model_id: model?.value.trim() || '',
    }))
    instance?.addEventListener('change', rememberAssistant)
    model?.addEventListener('change', rememberAssistant)
    refresh().catch(() => {
      setFeedback('#connection-feedback', text.error)
      setFeedback('#reasoning-connection-feedback', text.error)
    })
  })
})()
