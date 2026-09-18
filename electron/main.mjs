import { app, BrowserWindow } from 'electron'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronPort = 4175
process.env.TV_APP_ENV_FILE = app.isPackaged
  ? join(process.resourcesPath, 'app.env')
  : join(projectRoot, '.env')

const { startServer } = await import('../server.mjs')
let server = null

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#08111f',
    webPreferences: {
      preload: join(projectRoot, 'electron', 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.loadURL(`http://127.0.0.1:${electronPort}`)
    .catch((error) => console.error('TV Apps lango įkelti nepavyko:', error))
}

function waitForServer(server) {
  if (server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
}

app.whenReady().then(async () => {
  server = startServer({ host: '127.0.0.1', portNumber: electronPort })
  await waitForServer(server)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  console.error('TV Apps paleisti nepavyko:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  server?.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => server?.close())
