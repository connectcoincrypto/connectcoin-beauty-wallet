const { contextBridge, ipcRenderer } = require('electron');
const METHODS = new Set(['getState','prepareWallet','confirmWallet','cancelSetup','beginWalletReplacement','cancelWalletReplacement','restoreWallet','unlock','lock','previewSend','confirmSend','newAddress','getRecoveryPhrase','exportWallet','saveConfig','setTheme','setDeveloperMode','setClaims','refresh','openExternal','openDiagnostics','copyAddress']);
let lastActivity = 0;
for (const name of ['pointerdown', 'keydown']) window.addEventListener(name, () => {
  const now = Date.now();
  if (now - lastActivity > 5000) { lastActivity = now; ipcRenderer.send('beauty:activity'); }
}, { capture: true });
contextBridge.exposeInMainWorld('beauty', Object.freeze({
  invoke: async (method, payload = {}) => {
    if (!METHODS.has(method)) throw new Error('Unsupported wallet action.');
    const reply = await ipcRenderer.invoke('beauty:action', method, payload);
    if (!reply?.ok) throw new Error(reply?.error || 'The wallet action could not be completed.');
    return reply.value;
  },
  onState: callback => {
    if (typeof callback !== 'function') throw new Error('A callback is required.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('beauty:state', listener);
    return () => ipcRenderer.removeListener('beauty:state', listener);
  },
}));
