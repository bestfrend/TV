import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from 'node:http'

const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.env.PORT || 4174)
const httpUserAgent = 'tv-app/0.1'
const scrypt = promisify(scryptCallback)
const sessions = new Map()
const lrtStreamCache = new Map()
const iptvStreamCache = new Map()
const SESSION_TIMEOUT_MS = 60_000
const MAX_CLIENTS = 20
const LRT_STREAM_CACHE_MS = 20_000
const lrtProxyHosts = new Set(['stream-captions.lrt.lt', 'stream-secure.lrt.lt'])

function loadEnv() {
  const envPath = process.env.TV_APP_ENV_FILE || join(root, '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match || process.env[match[1]]) continue
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

loadEnv()

const configuredPasswordHash = process.env.TV_APP_PASSWORD_HASH || ''
const configuredPassword = process.env.TV_APP_PASSWORD || ''
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}
const lrtResolvers = {
  LTV1: 'https://www.lrt.lt/servisai/stream_url/live/get_live_url.php?channel=LTV1',
  LTV2: 'https://www.lrt.lt/servisai/stream_url/live/get_live_url.php?channel=LTV2',
}

function removeExpired() {
  const now = Date.now()
  for (const [token, session] of sessions) if (now - session.lastSeenAt > SESSION_TIMEOUT_MS) sessions.delete(token)
}

function getToken(request) {
  const authorization = request.headers.authorization || ''
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
}

function getSession(request) {
  removeExpired()
  const token = getToken(request)
  const session = token ? sessions.get(token) : null
  if (session) session.lastSeenAt = Date.now()
  return session || null
}

function activeUsers() {
  removeExpired()
  return [...sessions.values()].map(({ id, name, loggedInAt }) => ({ id, name, clientType: 'web', loggedInAt }))
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(payload === undefined ? '' : JSON.stringify(payload))
}

function requireSession(request, response) {
  const session = getSession(request)
  if (!session) { sendJson(response, 401, { error: 'Reikia prisijungti' }); return null }
  return session
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

async function verifyPassword(password) {
  if (configuredPassword) return password === configuredPassword
  if (!configuredPasswordHash) return false
  const [algorithm, salt, expectedHex] = configuredPasswordHash.split('$')
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false
  const expected = Buffer.from(expectedHex, 'hex')
  const actual = await scrypt(password, salt, expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function createSession(name) {
  removeExpired()
  if (sessions.size >= MAX_CLIENTS) return null
  const token = randomBytes(32).toString('hex')
  const session = { id: randomUUID(), name, token, loggedInAt: new Date().toISOString(), lastSeenAt: Date.now() }
  sessions.set(token, session)
  return session
}

function isHlsUrl(value) {
  return typeof value === 'string' && /^https:\/\/.+\.m3u8(?:\?|$)/i.test(value)
}

async function isHlsStreamAvailable(url) {
  if (!url) return false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 4_000)
  try {
    const result = await fetch(url, { signal: controller.signal, headers: { Range: 'bytes=0-2048', 'User-Agent': httpUserAgent } })
    if (result.body) await result.body.cancel()
    return result.ok
  } catch { return false } finally { clearTimeout(timeout) }
}

async function resolveLrtStream(channel) {
  const resolverUrl = lrtResolvers[channel]
  if (!resolverUrl) return null
  const cached = lrtStreamCache.get(channel)
  if (cached && cached.expiresAt > Date.now()) return cached.url
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const result = await fetch(resolverUrl, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': httpUserAgent } })
    if (!result.ok) return null
    const payload = await result.json()
    const data = payload?.response?.data
    // `content2` / `audio` are audio-only media playlists for these channels.
    // `content` is the signed master playlist that contains the video variants.
    // The browser receives it through our same-origin proxy, so the signed URL
    // remains usable even when the client device has a different IP address.
    const url = [data?.content, data?.content2, data?.audio].find(isHlsUrl) || null
    if (url) lrtStreamCache.set(channel, { url, expiresAt: Date.now() + LRT_STREAM_CACHE_MS })
    return url
  } catch { return null } finally { clearTimeout(timeout) }
}

function proxyHlsUrl(channel, upstreamUrl, inheritedSearch = '') {
  const upstream = new URL(upstreamUrl)
  const path = `${upstream.pathname}${upstream.search || inheritedSearch}`
  return `/api/tv/hls/${channel}?path=${encodeURIComponent(path)}&origin=${encodeURIComponent(upstream.origin)}`
}

function rewriteHlsPlaylist(channel, playlist, upstreamUrl) {
  const inheritedSearch = new URL(upstreamUrl).search
  const rewriteUri = (uri) => {
    const absoluteUri = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(uri.trim())
    return proxyHlsUrl(channel, new URL(uri, upstreamUrl).href, absoluteUri ? '' : inheritedSearch)
  }
  return playlist.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line
    if (line.trim().startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
        try { return `URI="${rewriteUri(uri)}"` } catch { return `URI="${uri}"` }
      })
    }
    try { return rewriteUri(line.trim()) } catch { return line }
  }).join('\n')
}

async function proxyLrtHls(request, response, channel) {
  const streamUrl = await resolveLrtStream(channel)
  if (!streamUrl) { sendJson(response, 502, { error: 'LRT srautas šiuo metu nepasiekiamas' }); return }
  const requestUrl = new URL(request.url || '/', 'http://localhost')
  const requestedPath = requestUrl.searchParams.get('path')
  const requestedOrigin = requestUrl.searchParams.get('origin') || new URL(streamUrl).origin
  let upstreamUrl = streamUrl
  if (requestedPath) {
    try {
      const origin = new URL(requestedOrigin)
      if (origin.protocol !== 'https:' || !lrtProxyHosts.has(origin.hostname)) throw new Error('Neleistinas LRT hostas')
      upstreamUrl = new URL(requestedPath, origin).href
    } catch {
      sendJson(response, 400, { error: 'Neteisingas HLS srauto kelias' }); return
    }
  }
  try {
    const headers = { 'User-Agent': httpUserAgent }
    if (request.headers.range) headers.Range = request.headers.range
    const result = await fetch(upstreamUrl, { headers })
    if (!result.ok) { sendJson(response, 502, { error: 'LRT srauto dalis nepasiekiama' }); return }
    const contentType = result.headers.get('content-type') || ''
    if (contentType.includes('mpegurl') || /\.m3u8(?:\?|$)/i.test(upstreamUrl)) {
      const playlist = rewriteHlsPlaylist(channel, await result.text(), upstreamUrl)
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' })
      response.end(playlist)
      return
    }
    const payload = Buffer.from(await result.arrayBuffer())
    response.writeHead(result.status, {
      'Content-Type': contentType || 'video/mp2t',
      'Cache-Control': 'no-store',
      'Content-Length': String(payload.length),
    })
    response.end(payload)
  } catch (error) {
    console.error(`LRT HLS tarpinio srauto klaida (${channel}):`, error)
    sendJson(response, 502, { error: 'LRT srauto paleisti nepavyko' })
  }
}

function proxyIptvUrl(channelId, upstreamUrl, inheritedSearch = '') {
  const upstream = new URL(upstreamUrl)
  const path = `${upstream.pathname}${upstream.search || inheritedSearch}`
  return `/api/tv/iptv-org/stream/${encodeURIComponent(channelId)}?path=${encodeURIComponent(path)}&origin=${encodeURIComponent(upstream.origin)}`
}

function rewriteIptvPlaylist(channelId, playlist, upstreamUrl) {
  const inheritedSearch = new URL(upstreamUrl).search
  const rewriteUri = (uri) => {
    const absoluteUri = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(uri.trim())
    return proxyIptvUrl(channelId, new URL(uri, upstreamUrl).href, absoluteUri ? '' : inheritedSearch)
  }
  return playlist.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line
    if (line.trim().startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
        try { return `URI="${rewriteUri(uri)}"` } catch { return `URI="${uri}"` }
      })
    }
    try { return rewriteUri(line.trim()) } catch { return line }
  }).join('\n')
}

async function proxyIptvHls(request, response, channelId) {
  const streamUrl = iptvStreamCache.get(channelId)
  if (!streamUrl) { sendJson(response, 404, { error: 'IPTV kanalas nerastas' }); return }
  const requestUrl = new URL(request.url || '/', 'http://localhost')
  const requestedPath = requestUrl.searchParams.get('path')
  const baseUrl = new URL(streamUrl)
  let upstreamUrl = streamUrl
  if (requestedPath) {
    try {
      const origin = new URL(requestUrl.searchParams.get('origin') || baseUrl.origin)
      if (origin.origin !== baseUrl.origin) throw new Error('Neleistinas IPTV hostas')
      upstreamUrl = new URL(requestedPath, origin).href
    } catch {
      sendJson(response, 400, { error: 'Neteisingas IPTV srauto kelias' }); return
    }
  }
  try {
    const headers = { 'User-Agent': httpUserAgent }
    if (request.headers.range) headers.Range = request.headers.range
    const result = await fetch(upstreamUrl, { headers })
    if (!result.ok) { sendJson(response, 502, { error: 'IPTV srauto dalis nepasiekiama' }); return }
    const contentType = result.headers.get('content-type') || ''
    if (contentType.includes('mpegurl') || /\.m3u8(?:\?|$)/i.test(upstreamUrl)) {
      const playlist = rewriteIptvPlaylist(channelId, await result.text(), upstreamUrl)
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' })
      response.end(playlist)
      return
    }
    const payload = Buffer.from(await result.arrayBuffer())
    response.writeHead(result.status, {
      'Content-Type': contentType || 'video/mp2t',
      'Cache-Control': 'no-store',
      'Content-Length': String(payload.length),
    })
    response.end(payload)
  } catch (error) {
    console.error(`IPTV HLS tarpinio srauto klaida (${channelId}):`, error)
    sendJson(response, 502, { error: 'IPTV srauto paleisti nepavyko' })
  }
}

async function handleApi(request, response, pathname) {
  if (pathname === '/api/health' && request.method === 'GET') { sendJson(response, 200, { ok: true, service: 'TV App API' }); return }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    const body = await readBody(request)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!name || name.length > 40 || !password) { sendJson(response, 400, { error: 'Įveskite vardą ir slaptažodį' }); return }
    if (!(await verifyPassword(password))) { sendJson(response, 401, { error: 'Neteisingas vardas arba slaptažodis' }); return }
    const session = createSession(name)
    if (!session) { sendJson(response, 409, { error: 'Pasiektas TV Apps vartotojų limitas' }); return }
    sendJson(response, 200, { token: session.token, user: { id: session.id, name: session.name, clientType: 'web', loggedInAt: session.loggedInAt } })
    return
  }

  if (pathname === '/api/pwa/install-authorize' && request.method === 'POST') {
    const body = await readBody(request)
    const password = typeof body.password === 'string' ? body.password : ''
    if (!password || !(await verifyPassword(password))) {
      sendJson(response, 401, { error: 'Neteisingas kodas' })
      return
    }
    sendJson(response, 200, { authorized: true })
    return
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = getToken(request)
    if (token) sessions.delete(token)
    response.writeHead(204); response.end(); return
  }

  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const session = requireSession(request, response)
    if (!session) return
    sendJson(response, 200, { user: { id: session.id, name: session.name, clientType: 'web', loggedInAt: session.loggedInAt }, users: activeUsers() })
    return
  }

  if (pathname === '/api/auth/heartbeat' && request.method === 'POST') {
    if (!requireSession(request, response)) return
    sendJson(response, 200, { users: activeUsers() }); return
  }

  if (pathname === '/api/tv/availability' && request.method === 'GET') {
    const channels = await Promise.all(Object.keys(lrtResolvers).map(async (channel) => ({ channel, available: await isHlsStreamAvailable(await resolveLrtStream(channel)) })))
    sendJson(response, 200, { channels }); return
  }

  const hlsProxyMatch = pathname.match(/^\/api\/tv\/hls\/(LTV1|LTV2)$/i)
  if (hlsProxyMatch && request.method === 'GET') {
    await proxyLrtHls(request, response, hlsProxyMatch[1].toUpperCase()); return
  }

  const iptvProxyMatch = pathname.match(/^\/api\/tv\/iptv-org\/stream\/([^/]+)$/)
  if (iptvProxyMatch && request.method === 'GET') {
    await proxyIptvHls(request, response, decodeURIComponent(iptvProxyMatch[1])); return
  }

  const streamMatch = pathname.match(/^\/api\/tv\/stream\/([^/]+)$/)
  if (streamMatch && request.method === 'GET') {
    const channel = streamMatch[1].toUpperCase()
    if (!lrtResolvers[channel]) { sendJson(response, 404, { error: 'TV kanalas nerastas' }); return }
    const url = await resolveLrtStream(channel)
    if (!url) { sendJson(response, 502, { error: 'LRT srautas šiuo metu nepasiekiamas' }); return }
    sendJson(response, 200, { channel, url, type: 'hls' }); return
  }

  if (pathname === '/api/tv/iptv-org' && request.method === 'GET') {
    try {
      const result = await fetch('https://iptv-org.github.io/iptv/countries/lt.m3u', { headers: { 'User-Agent': httpUserAgent } })
      if (!result.ok) { sendJson(response, 502, { error: 'IPTV-org grojaraščio gauti nepavyko' }); return }
      const lines = (await result.text()).split(/\r?\n/)
      const channels = []
      for (let index = 0; index < lines.length - 1; index += 1) {
        const info = lines[index]
        const url = lines[index + 1]?.trim()
        if (!info.startsWith('#EXTINF') || !url || !/^https?:\/\//i.test(url)) continue
        const name = info.split(',').slice(1).join(',').trim()
        if (!name) continue
        const id = `iptv-org-${channels.length}`
        iptvStreamCache.set(id, url)
        channels.push({ id, name, description: 'Dinaminis IPTV-org viešas HLS srautas', badge: 'TV', directStreamUrl: url, source: 'iptv-org', available: false })
        index += 1
      }
      const checked = await Promise.all(channels.map(async (channel) => ({ ...channel, available: await isHlsStreamAvailable(channel.directStreamUrl) })))
      sendJson(response, 200, { channels: checked })
    } catch (error) {
      console.error('IPTV-org grojaraščio klaida:', error)
      sendJson(response, 502, { error: 'IPTV-org šiuo metu nepasiekiamas' })
    }
    return
  }

  sendJson(response, 404, { error: 'API kelias nerastas' })
}

async function serveFile(request, response) {
  const requestedPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
  const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.slice(1)
  const filePath = normalize(join(root, relativePath))
  if (!filePath.startsWith(normalize(root))) { response.writeHead(403); response.end('Forbidden'); return }
  try {
    const payload = await readFile(filePath)
    response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream', 'Cache-Control': requestedPath === '/' ? 'no-cache' : 'public, max-age=300' })
    response.end(payload)
  } catch {
    const payload = await readFile(join(root, 'index.html'))
    response.writeHead(200, { 'Content-Type': mimeTypes['.html'], 'Cache-Control': 'no-cache' })
    response.end(payload)
  }
}

export function startServer({ host = '0.0.0.0', portNumber = port } = {}) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname
    if (pathname.startsWith('/api/')) { void handleApi(request, response, pathname); return }
    void serveFile(request, response)
  })
  server.listen(portNumber, host, () => {
    console.log(`TV Apps serveris veikia: http://localhost:${portNumber}`)
    if (!configuredPasswordHash && !configuredPassword) console.warn('Nustatykite TV_APP_PASSWORD arba TV_APP_PASSWORD_HASH faile .env')
  })
  return server
}

const directRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (directRun) startServer()
