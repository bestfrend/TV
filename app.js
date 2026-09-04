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
const landscapeMediaQuery = window.matchMedia('(orientation: landscape) and (max-height: 620px) and (max-width: 900px)')
let playerHeaderHideTimer = null
let channelTitleHideTimer = null

function showPlayerHeader() {
  const header = document.querySelector('.player-header')
  if (!header) return
  header.classList.remove('is-hidden')
  clearTimeout(playerHeaderHideTimer)
  if (landscapeMediaQuery.matches) {
    playerHeaderHideTimer = setTimeout(() => header.classList.add('is-hidden'), 5000)
  }
}

function syncLandscapePlayerUi() {
  const player = document.querySelector('#player')
  const video = document.querySelector('#video')
  if (!player || !video) return
  const isLandscape = landscapeMediaQuery.matches
  player.classList.toggle('is-landscape', isLandscape)
  // The player has its own top bar; never show the browser's bottom controls.
  video.removeAttribute('controls')
  showPlayerHeader()
}

function changeChannel(direction) {
  const nextIndex = currentChannelIndex + direction
  if (nextIndex < 0 || nextIndex >= channels.length) return
  openPlayer(channels[nextIndex])
}

function updateVolumeIcon(value) {
  const icon = document.querySelector('#volume-icon')
  if (icon) icon.textContent = value === 0 ? '🔇' : '🔊'
}

function showChannelTitle(title) {
  const overlay = document.querySelector('#player-channel-title')
  if (!overlay) return
  clearTimeout(channelTitleHideTimer)
  overlay.textContent = title
  overlay.classList.remove('is-hidden')
  channelTitleHideTimer = setTimeout(() => overlay.classList.add('is-hidden'), 3500)
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
  document.querySelector('.player-header').insertAdjacentHTML('beforeend', '<button id="previous-channel" class="channel-nav-button" type="button" aria-label="Ankstesnis kanalas">‹</button><button id="next-channel" class="channel-nav-button" type="button" aria-label="Kitas kanalas">›</button>')
  const volumeLabel = document.querySelector('.player-volume')
  volumeLabel.insertAdjacentHTML('afterbegin', '<span id="volume-icon" aria-hidden="true">🔊</span>')
  if (volumeLabel.childNodes[1]?.nodeType === Node.TEXT_NODE) volumeLabel.childNodes[1].textContent = ''
  document.querySelector('.player').insertAdjacentHTML('beforeend', '<div id="player-channel-title" class="player-channel-title" aria-live="polite"></div>')
  document.querySelector('.directory-heading > div').insertAdjacentHTML('beforeend', '<button id="retry-load" class="retry-load hidden" type="button">Atnaujinti</button>')
  setupPwaInstall()
  document.querySelector('#back').addEventListener('click', closePlayer)
  document.querySelector('#previous-channel').addEventListener('click', () => changeChannel(-1))
  document.querySelector('#next-channel').addEventListener('click', () => changeChannel(1))
  document.querySelector('#retry-load').addEventListener('click', loadChannels)
  syncLandscapePlayerUi()
  document.querySelector('#player').addEventListener('click', showPlayerHeader)
  document.querySelector('#volume').addEventListener('input', (event) => {
    const value = Number(event.target.value)
    document.querySelector('#video').volume = value
    document.querySelector('#video').muted = value === 0
    updateVolumeIcon(value)
    document.querySelector('#volume-level').textContent = `${Math.round(value / 0.65 * 5)}/5`
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
  grid.innerHTML = channels.map((channel) => `<button class="channel-card" data-channel-id="${escapeHtml(channel.id)}">
    <span class="channel-badge">${escapeHtml(channel.badge || 'TV')}</span><span class="channel-copy"><b>${escapeHtml(channel.name)}</b><small>${escapeHtml(channel.description || 'Viešas TV srautas')}</small><small class="channel-status ${channel.available ? 'is-available' : ''}">${channel.available ? 'Srautas veikia' : 'Srautas nepatikrintas arba neveikia'}</small></span><span class="open-arrow">›</span>
  </button>`).join('') || '<p class="empty">Kanalų rasti nepavyko.</p>'
  grid.querySelectorAll('[data-channel-id]').forEach((card) => card.addEventListener('click', () => openPlayer(channels.find((channel) => channel.id === card.dataset.channelId))))
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
  const error = document.querySelector('#player-error')
  currentHls?.destroy()
  currentHls = null
  video.pause()
  video.removeAttribute('src')
  video.load()
  document.querySelector('#player-title').textContent = channel.name
  showChannelTitle(channel.name)
  document.querySelector('#volume').value = '0.65'
  document.querySelector('#volume-level').textContent = '5/5'
  updateVolumeIcon(0.65)
  error.textContent = 'Jungiamasi…'
  player.classList.remove('hidden')
  document.body.classList.add('player-open')
  showPlayerHeader()
  try {
    const streamUrl = channel.streamChannel
      ? (await (await api(`/tv/stream/${channel.streamChannel}`)).json()).url
      : channel.directStreamUrl
    if (!streamUrl) throw new Error('Srauto gauti nepavyko')
    error.textContent = ''
    const play = () => video.play().catch(() => { error.textContent = 'Paspauskite vaizdą, kad pradėtumėte transliaciją.' })
    if (HlsPlayer?.isSupported()) {
      currentHls = new HlsPlayer({ enableWorker: false, lowLatencyMode: false })
      currentHls.on(HlsPlayer.Events.MANIFEST_PARSED, play)
      currentHls.on(HlsPlayer.Events.ERROR, (_event, data) => { if (data.fatal) error.textContent = 'Šio kanalo paleisti nepavyksta.' })
      currentHls.loadSource(streamUrl)
      currentHls.attachMedia(video)
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl
      video.addEventListener('loadedmetadata', play, { once: true })
    } else {
      throw new Error('Ši naršyklė nepalaiko HLS vaizdo.')
    }
  } catch (loadError) {
    error.textContent = loadError instanceof Error ? loadError.message : 'Srauto paleisti nepavyko.'
  }
}

function closePlayer() {
  currentHls?.destroy()
  currentHls = null
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?v=5').catch(() => undefined)
void start()
