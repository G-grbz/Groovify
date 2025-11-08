import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  updateLanguage: (lang) => ipcRenderer.invoke('update-language', lang),
  getCurrentLanguage: () => ipcRenderer.invoke('get-current-language'),
  platform: process.platform,
  versions: process.versions
});

console.log('✅ Electron ön yükleme betiği yüklendi');
