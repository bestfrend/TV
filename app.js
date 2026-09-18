const app = document.querySelector('#app')
const HlsPlayer = window.Hls
const storedApiBase = localStorage.getItem('tv-app-api-base')
const queryApiBase = new URLSearchParams(window.location.search).get('api')
const apiBase = (queryApiBase || storedApiBase || `${window.location.origin}/api`).replace(/\/$/, '')

const officialChannels = [
  { id: 'lrt-televizija', name: 'LRT TELEVIZIJA', description: 'Žinios, aktualijos, kultūra ir pramogos', badge: 'LRT', streamChannel: 'LTV1', official: true },
  { id: 'lrt-plius', name: 'LRT PLIUS', description: 'Kultūra, dokumentika, sportas ir kinas', badge: 'LRT+', streamChannel: 'LTV2', official: true },
]

let channels = []
let currentHls = null
let deferredInstallPrompt = null
let currentChannelIndex = -1
let lastAudibleVolume = 0.65
const landscapeMediaQuery = window.matchMedia('(orientation: landscape) and (max-height: 620px) and (max-width: 900px)')
let playerHeaderHideTimer = null
let channelTitleHideTimer = null
let playerErrorHideTimer = null

function showPlayerHeader() {
  const header = document.querySelector('.player-header')
  if (!header) return
  header.classList.remove('is-hidden')
  clearTimeout(playerHeaderHideTimer)
  playerHeaderHideTimer = setTimeout(() => header.classList.add('is-hidden'), 5000)
}

function syncLandscapePlayerUi() {
  const player = document.querySelector('#player')
  const video = document.querySelector('#video')
  if (!player || !video) return
  const isLandscape = landscapeMediaQuery.matches
  player.classList.toggle('is-landscape', isLandscape)
  // The player has its own top bar; never show the browser's bottom controls.
  video.removeAttribute('controls')
  video.controls = false
  video.disablePictureInPicture = true
  video.setAttribute('disablepictureinpicture', '')
  showPlayerHeader()
}

function changeChannel(direction) {
  if (!channels.length) return
  const nextIndex = (currentChannelIndex + direction + channels.length) % channels.length
  openPlayer(channels[nextIndex])
}

function getChannelNumber(channel) {
  const index = channels.findIndex((item) => item.id === channel?.id)
  return index >= 0 ? index + 1 : 0
}

function getChannelLabel(channel) {
  const number = getChannelNumber(channel)
  return number ? `${number}. ${channel.name}` : channel.name
}

function flashChannelButton(button) {
  button.classList.remove('is-pressed')
  void button.offsetWidth
  button.classList.add('is-pressed')
  setTimeout(() => button.classList.remove('is-pressed'), 300)
}

function updateVolumeIcon(value, muted = false) {
  const icon = document.querySelector('#volume-icon')
  if (icon) icon.textContent = muted || value === 0 ? '\u{1F507}' : '\u{1F50A}'
}

function updateVolumeLevel(value) {
  const level = document.querySelector('#volume-level')
  if (level) level.textContent = `${Math.round(value / 0.65 * 5)}/5`
}

function toggleFrameMute() {
  const video = document.querySelector('#video')
  const volumeInput = document.querySelector('#volume')
  if (!video || !volumeInput) return
  if (video.muted || video.volume === 0) {
    const restoredValue = Math.max(lastAudibleVolume, 0.13)
    volumeInput.value = String(restoredValue)
    video.volume = restoredValue
    video.muted = false
    updateVolumeIcon(restoredValue, false)
    updateVolumeLevel(restoredValue)
    return
  }
  lastAudibleVolume = Math.max(video.volume, 0.13)
  video.muted = true
  updateVolumeIcon(video.volume, true)
}

function setFixedChannelQuality(hls) {
  const quality = hls.levels
    .map((level, index) => ({ level, index }))
    .find(({ level }) => Number(level.height) === 540)
    || hls.levels
      .map((level, index) => ({ level, index }))
      .sort((a, b) => Number(a.level.height) - Number(b.level.height))[0]
  if (quality) {
    hls.autoLevelCapping = quality.index
    hls.currentLevel = quality.index
  }
}

function showChannelTitle(title) {
  const overlay = document.querySelector('#player-channel-title')
  if (!overlay) return
  clearTimeout(channelTitleHideTimer)
  overlay.textContent = title
  overlay.classList.remove('is-hidden')
  channelTitleHideTimer = setTimeout(() => overlay.classList.add('is-hidden'), 3500)
}

function setPlayerError(message, hideAfterMs = 0) {
  const error = document.querySelector('#player-error')
  if (!error) return
  clearTimeout(playerErrorHideTimer)
  error.textContent = message
  if (hideAfterMs > 0) playerErrorHideTimer = setTimeout(() => { error.textContent = '' }, hideAfterMs)
}

function setServerState(message, canRetry = false) {
  const status = document.querySelector('#channel-message')
  const retry = document.querySelector('#retry-load')
  if (status) status.textContent = message
  if (retry) retry.classList.toggle('hidden', !canRetry)
}

function isInstalledPwa() {
  return window.matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches
    || window.navigator.standalone === true
    || new URLSearchParams(window.location.search).get('pwa') === '1'
}

function api(path, options = {}) {
  return fetch(`${apiBase}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  })
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]))
}

function renderDirectory(message = '') {
  app.innerHTML = `<main class="app-shell"><header class="app-header">
    <div><span class="eyebrow">TV APP</span><h1>Lietuviška TV</h1></div>
  </header><section class="directory">
    <div class="directory-heading"><div><h2>Pasirinkite kanalą</h2><p id="channel-message">${message || 'Tikrinami kanalų srautai…'}</p></div><strong id="channel-count">Veikia 0 iš 0</strong></div>
    <div class="channel-grid" id="channel-grid"></div>
    <section class="pwa-install-card${isInstalledPwa() ? ' hidden' : ''}" aria-labelledby="pwa-title">
      <div><span class="eyebrow">TELEFONUI</span><h2 id="pwa-title">Įsidiekite TV programėlę</h2><p id="pwa-message">Atsisiųskite TV Apps į telefono pradžios ekraną.</p></div>
      <button class="pwa-install-button" id="pwa-install" type="button">Įdiegti PWA</button>
    </section>
  </section></main><div class="pwa-dialog hidden" id="pwa-dialog" aria-hidden="true">
    <div class="pwa-dialog-backdrop" data-pwa-close></div>
    <form class="pwa-dialog-card" id="pwa-form">
      <button class="pwa-dialog-close" type="button" data-pwa-close aria-label="Uždaryti">×</button>
      <h2>Įveskite kodą</h2><p>Norint įsidiegti PWA, reikia įvesti tą patį kodą.</p>
      <label>Kodas<input id="pwa-password" name="password" type="password" autocomplete="current-password" required autofocus></label>
      <p class="error hidden" id="pwa-error" role="alert"></p><button class="pwa-submit" type="submit">Patvirtinti ir įdiegti</button>
    </form>
  </div><div class="player hidden" id="player"><header class="player-header"><button id="back">← Visi kanalai</button><strong id="player-title"></strong><label class="player-volume">🔊 <input id="volume" type="range" min="0" max="0.65" step="0.13" value="0.65" aria-label="Garsumas"><span id="volume-level">5/5</span></label></header><video id="video" controls playsinline></video><p id="player-error"></p></div>`
  document.querySelector('.player-header').insertAdjacentHTML('beforeend', '<div class="channel-switcher" role="group" aria-label="Kanalų keitimas"><button id="previous-channel" class="channel-nav-button btn btn-light" type="button" aria-label="Ankstesnis kanalas"><span class="channel-nav-glyph" aria-hidden="true">‹</span></button><button id="next-channel" class="channel-nav-button btn btn-light" type="button" aria-label="Kitas kanalas"><span class="channel-nav-glyph" aria-hidden="true">›</span></button></div>')
  const playerHeader = document.querySelector('.player-header')
  const volumeLabel = document.querySelector('.player-volume')
  const channelSwitcher = document.querySelector('.channel-switcher')
  const playerHeaderLayout = document.createElement('div')
  playerHeaderLayout.className = 'player-header-layout'
  playerHeader.append(playerHeaderLayout)
  playerHeaderLayout.append(document.querySelector('#back'), document.querySelector('#player-title'), channelSwitcher, volumeLabel)
  volumeLabel.innerHTML = '<button id="volume-toggle" class="volume-toggle" type="button" aria-label="Garso nustatymai" aria-expanded="false" aria-controls="volume-panel"><span id="volume-icon" aria-hidden="true">&#128266;</span></button><div id="volume-panel" class="volume-panel"><input id="volume" type="range" min="0" max="0.65" step="0.13" value="0.65" aria-label="Garsumas"><span id="volume-level">5/5</span></div>'
  document.querySelector('.player').insertAdjacentHTML('beforeend', '<div id="player-channel-title" class="player-channel-title" aria-live="polite"></div>')
  document.querySelector('.directory-heading > div').insertAdjacentHTML('beforeend', '<button id="retry-load" class="retry-load hidden" type="button">Atnaujinti</button>')
  setupPwaInstall()
  document.querySelector('#back').addEventListener('click', closePlayer)
  document.querySelector('#previous-channel').addEventListener('click', (event) => { flashChannelButton(event.currentTarget); setTimeout(() => changeChannel(-1), 100) })
  document.querySelector('#next-channel').addEventListener('click', (event) => { flashChannelButton(event.currentTarget); setTimeout(() => changeChannel(1), 100) })
  document.querySelector('#retry-load').addEventListener('click', loadChannels)
  document.querySelector('#volume-toggle').addEventListener('click', (event) => {
    event.stopPropagation()
    const video = document.querySelector('#video')
    const volumeInput = document.querySelector('#volume')
    const currentValue = Number(volumeInput.value)
    if (video.muted || currentValue === 0) {
      const restoredValue = 0.13
      volumeInput.value = String(restoredValue)
      video.volume = restoredValue
      video.muted = false
      updateVolumeIcon(restoredValue)
      document.querySelector('#volume-level').textContent = '1/5'
      volumeLabel.classList.remove('is-open')
      event.currentTarget.setAttribute('aria-expanded', 'false')
      return
    }
    const isOpen = volumeLabel.classList.toggle('is-open')
    event.currentTarget.setAttribute('aria-expanded', String(isOpen))
  })
  syncLandscapePlayerUi()
  document.querySelector('#player').addEventListener('click', showPlayerHeader)
  document.querySelector('#video').addEventListener('click', toggleFrameMute)
  document.querySelector('#player').addEventListener('pointermove', showPlayerHeader, { passive: true })
  document.querySelector('#player').addEventListener('pointerdown', showPlayerHeader, { passive: true })
  document.querySelector('#volume').addEventListener('input', (event) => {
    const value = Number(event.target.value)
    document.querySelector('#video').volume = value
    document.querySelector('#video').muted = value === 0
    if (value > 0) lastAudibleVolume = value
    updateVolumeIcon(value, value === 0)
    updateVolumeLevel(value)
  })
  renderChannels()
}

function setPwaMessage(message) {
  const element = document.querySelector('#pwa-message')
  if (element) element.textContent = message
}

function closePwaDialog() {
  const dialog = document.querySelector('#pwa-dialog')
  if (!dialog) return
  dialog.classList.add('hidden')
  dialog.setAttribute('aria-hidden', 'true')
}

function setupPwaInstall() {
  const installButton = document.querySelector('#pwa-install')
  const dialog = document.querySelector('#pwa-dialog')
  const form = document.querySelector('#pwa-form')
  if (!installButton || !dialog || !form) return
  installButton.addEventListener('click', () => {
    dialog.classList.remove('hidden')
    dialog.setAttribute('aria-hidden', 'false')
    document.querySelector('#pwa-password')?.focus()
  })
  dialog.querySelectorAll('[data-pwa-close]').forEach((element) => element.addEventListener('click', closePwaDialog))
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const passwordInput = document.querySelector('#pwa-password')
    const error = document.querySelector('#pwa-error')
    const submit = form.querySelector('button[type="submit"]')
    error.classList.add('hidden')
    submit.disabled = true
    try {
      const response = await api('/pwa/install-authorize', { method: 'POST', body: JSON.stringify({ password: passwordInput.value }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.authorized) throw new Error(data.error || 'Kodas neteisingas')
      passwordInput.value = ''
      closePwaDialog()
      if (deferredInstallPrompt) {
        const installPrompt = deferredInstallPrompt
        deferredInstallPrompt = null
        await installPrompt.prompt()
        const result = await installPrompt.userChoice
        setPwaMessage(result.outcome === 'accepted' ? 'TV Apps įdiegta telefone.' : 'PWA diegimas atšauktas.')
      } else {
        setPwaMessage('Kodas teisingas. Naršyklės meniu pasirinkite „Įtraukti į pradžios ekraną“.')
      }
    } catch (installError) {
      error.textContent = installError instanceof Error ? installError.message : 'PWA įdiegti nepavyko.'
      error.classList.remove('hidden')
    } finally {
      submit.disabled = false
    }
  })
}

function renderChannels() {
  const grid = document.querySelector('#channel-grid')
  if (!grid) return
  const available = channels.filter((channel) => channel.available === true).length
  document.querySelector('#channel-count').textContent = `Veikia ${available} iš ${channels.length}`
  grid.innerHTML = channels.map((channel, index) => `<button class="channel-card" data-channel-id="${escapeHtml(channel.id)}">
    <span class="channel-badge">${escapeHtml(channel.badge || 'TV')}</span><span class="channel-copy"><b>${index + 1}. ${escapeHtml(channel.name)}</b><small>${escapeHtml(channel.description || 'Viešas TV srautas')}</small><small class="channel-status ${channel.available ? 'is-available' : ''}">${channel.available ? 'Srautas veikia' : 'Srautas nepatikrintas arba neveikia'}</small></span><span class="open-arrow">›</span>
  </button>`).join('') || '<p class="empty">Kanalų rasti nepavyko.</p>'
  grid.querySelectorAll('[data-channel-id]').forEach((card) => card.addEventListener('click', () => {
    flashChannelButton(card)
    setTimeout(() => openPlayer(channels.find((channel) => channel.id === card.dataset.channelId)), 260)
  }))
}

async function loadChannels() {
  setServerState('Jungiamasi prie serverio…')
  const serverReady = await api('/health').then((response) => response.ok).catch(() => false)
  if (!serverReady) {
    setServerState('Serveris bunda dėl nemokamo Render plano. Palaukite ir paspauskite „Atnaujinti“.', true)
    return
  }
  const [availabilityResult, externalResult] = await Promise.all([
    api('/tv/availability').then((response) => response.ok ? response.json() : { channels: [] }).catch(() => ({ channels: [] })),
    api('/tv/iptv-org').then((response) => response.ok ? response.json() : { channels: [] }).catch(() => ({ channels: [] })),
  ])
  const availability = new Map((availabilityResult.channels || []).map((item) => [item.channel, item.available === true]))
  channels = officialChannels.map((channel) => ({ ...channel, available: availability.get(channel.streamChannel) === true }))
    .concat((externalResult.channels || []).map((channel) => ({ ...channel, official: false })))
  renderChannels()
  setServerState('Kanalai įkelti.')
  const message = document.querySelector('#channel-message')
  if (message) message.textContent = 'LRT kanalai yra oficialūs, o kiti kanalai gaunami iš viešo IPTV sąrašo.'
}

async function openPlayer(channel) {
  if (!channel) return
  currentChannelIndex = channels.findIndex((item) => item.id === channel.id)
  const player = document.querySelector('#player')
  const video = document.querySelector('#video')
  const channelLabel = getChannelLabel(channel)
  currentHls?.destroy()
  currentHls = null
  clearTimeout(playerErrorHideTimer)
  video.pause()
  video.removeAttribute('src')
  video.load()
  document.querySelector('#player-title').textContent = String(getChannelNumber(channel) || '')
  showChannelTitle(channelLabel)
  document.querySelector('#volume').value = '0.65'
  document.querySelector('#volume-level').textContent = '5/5'
  lastAudibleVolume = 0.65
  updateVolumeIcon(0.65)
  setPlayerError('Jungiamasi…')
  player.classList.remove('hidden')
  document.body.classList.add('player-open')
  showPlayerHeader()
  try {
    const streamUrl = channel.streamChannel
      ? `${apiBase}/tv/hls/${encodeURIComponent(channel.streamChannel)}`
      : channel.source === 'iptv-org'
        ? `${apiBase}/tv/iptv-org/stream/${encodeURIComponent(channel.id)}`
      : channel.directStreamUrl
    if (!streamUrl) throw new Error('Srauto gauti nepavyko')
    setPlayerError('')
    const play = () => { void video.play().catch(() => undefined) }
    if (HlsPlayer?.isSupported()) {
      const hls = new HlsPlayer({
        enableWorker: false,
        lowLatencyMode: false,
        capLevelToPlayerSize: true,
        maxBufferLength: 20,
        backBufferLength: 30,
      })
      currentHls = hls
      hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => {
        setFixedChannelQuality(hls)
        play()
      })
      currentHls.on(HlsPlayer.Events.ERROR, (_event, data) => { if (data.fatal) setPlayerError('Šio kanalo paleisti nepavyksta.', 7000) })
      hls.loadSource(streamUrl)
      hls.attachMedia(video)
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl
      video.addEventListener('loadedmetadata', play, { once: true })
    } else {
      throw new Error('Ši naršyklė nepalaiko HLS vaizdo.')
    }
  } catch (loadError) {
    setPlayerError(loadError instanceof Error ? loadError.message : 'Srauto paleisti nepavyko.', 7000)
  }
}

function closePlayer() {
  currentHls?.destroy()
  currentHls = null
  clearTimeout(playerErrorHideTimer)
  const video = document.querySelector('#video')
  video.pause()
  video.removeAttribute('src')
  video.load()
  document.querySelector('#player').classList.add('hidden')
  document.body.classList.remove('player-open')
}

async function start() {
  renderDirectory()
  await loadChannels()
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  deferredInstallPrompt = event
})

window.addEventListener('appinstalled', () => {
  document.querySelector('.pwa-install-card')?.classList.add('hidden')
})

landscapeMediaQuery.addEventListener?.('change', syncLandscapePlayerUi)
window.addEventListener('orientationchange', syncLandscapePlayerUi)

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?v=33').catch(() => undefined)
void start()
