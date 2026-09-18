import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('tvApps', {
  isElectron: true,
})
