import { app, BrowserWindow, ipcMain, Menu, dialog, shell, clipboard, powerMonitor } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { copyFile, chmod, constants, realpath } from 'node:fs/promises';
import { WalletService } from './core/wallet-service.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const INDEX = join(ROOT, 'ui', 'index.html');
const UI_URL = pathToFileURL(INDEX).href;
const SERVICE_METHODS = new Set(['getState','prepareWallet','confirmWallet','cancelSetup','restoreWallet','unlock','lock','previewSend','confirmSend','newAddress','getRecoveryPhrase','saveConfig','setClaims','refresh']);
const EXTERNAL = new Set(['https://connectcoincrypto.com/','https://connectcoincrypto.com/whitepaper.pdf','https://explorer.connectcoincrypto.com/','https://github.com/connectcoincrypto/connectcoin-beauty-wallet','https://github.com/connectcoincrypto/connectcoin','https://discord.gg/JYWbz5PsPp']);
let window, service, quitting = false, actionInProgress = false;

// Development UI tests use isolated temporary profiles; installed builds ignore this override.
if (!app.isPackaged && process.env.BEAUTY_TEST_PROFILE) app.setPath('userData', resolve(process.env.BEAUTY_TEST_PROFILE));
else app.setPath('userData', join(app.getPath('appData'), 'ConnectCoin Beauty Wallet'));
app.setName('ConnectCoin Beauty Wallet');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.focus(); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    void service?.close().finally(() => app.exit(0));
    if (!service) app.exit(0);
  });
  app.on('window-all-closed', () => app.quit());
  // Do not top-level-await readiness: Electron waits for ESM evaluation first.
  void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    service = new WalletService({ directory: app.getPath('userData'), resourcesPath: process.resourcesPath });
    await service.initialize();
    window = new BrowserWindow({
      width: 1380, height: 940, minWidth: 1000, minHeight: 700, show: false,
      icon: join(ROOT, '..', 'assets', 'icon.png'),
      title: 'ConnectCoin Beauty Wallet', backgroundColor: '#f7f7f2',
      webPreferences: {
        preload: join(ROOT, 'preload.cjs'), nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, spellcheck: false, devTools: !app.isPackaged,
        partition: 'beauty-wallet-ui', navigateOnDragDrop: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    const session = window.webContents.session;
    session.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith(pathToFileURL(join(ROOT,'ui')).href + '/') || details.url.startsWith('data:image/');
      callback({ cancel: !allowed });
    });
    service.on('state', state => { if (window && !window.isDestroyed()) window.webContents.send('beauty:state',state); });
    powerMonitor.on('suspend', () => { void service.lock(); });
    powerMonitor.on('lock-screen', () => { void service.lock(); });
    ipcMain.on('beauty:activity', event => {
      if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === UI_URL) service.activity();
    });
    ipcMain.handle('beauty:action', async (event,method,payload) => {
      try {
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== UI_URL) throw new Error('Untrusted wallet window.');
        if (typeof method !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload) || Buffer.byteLength(JSON.stringify(payload)) > 16384) throw new Error('Invalid wallet action.');
        if (method === 'getState') return { ok:true,value:service.getState() };
        // Lock can interrupt pending network/KDF work; other mutations are serialized.
        if (method === 'lock') return { ok:true,value:await service.lock() };
        if (actionInProgress) throw new Error('Another wallet action is in progress. Please wait.');
        actionInProgress = true; service.activity();
        try {
          let value;
          if (SERVICE_METHODS.has(method)) value = await service[method](payload);
          else if (method === 'copyAddress') {
            service.assertSession(); const address = service.getState().wallet.address;
            if (!address) throw new Error('No receive address is available.');
            clipboard.writeText(address); value = { copied:true };
          } else if (method === 'openExternal') {
            const url = new URL(payload.url).href;
            const explorer = new URL(url);
            const allowedTransaction = explorer.origin === 'https://explorer.connectcoincrypto.com' && /^\/tx\/[0-9a-f]{64}\/?$/.test(explorer.pathname) && !explorer.search && !explorer.hash;
            if (!EXTERNAL.has(url) && !allowedTransaction) throw new Error('This external link is not allowed.');
            await shell.openExternal(url); value = { opened:true };
          } else if (method === 'exportWallet') {
            service.assertSession();
            const selection = await dialog.showSaveDialog(window,{ title:'Save encrypted wallet backup',defaultPath:'beauty-wallet-backup.json',filters:[{name:'Encrypted wallet',extensions:['json']}] });
            if (selection.canceled || !selection.filePath) value = { cancelled:true };
            else {
              if (await realpath(selection.filePath).catch(()=>selection.filePath) === await realpath(service.vaultFile)) throw new Error('Choose a different file for your backup.');
              await service.persisting;
              await copyFile(service.vaultFile,selection.filePath,constants.COPYFILE_EXCL);
              await chmod(selection.filePath,0o600); value = { saved:true };
            }
          } else throw new Error('Unsupported wallet action.');
          return { ok:true,value };
        } finally { actionInProgress = false; }
      } catch(error) {
        // Do not serialize stacks, config files, process environments, or secrets.
        return { ok:false,error:String(error.message ?? 'Wallet action failed.').slice(0,500) };
      }
    });
    window.once('ready-to-show', () => { window.show(); });
    await window.loadFile(INDEX);
  } catch {
    dialog.showErrorBox('Beauty Wallet could not start','Check the configuration file in your Beauty Wallet data folder. The wallet has not sent any transaction.');
    app.quit();
  }
  });
}
