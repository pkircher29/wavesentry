const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startServer, stopMonitoring, server } = require('./server.js');

let mainWindow;

async function createWindow() {
  let port = 3000;
  try {
    port = await startServer();
  } catch (err) {
    console.error('Failed to start embedded server:', err);
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#090b0f',
    autoHideMenuBar: true,
    title: 'WaveSentry Pro',
    icon: path.join(__dirname, '..', 'public', 'favicon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

app.on('before-quit', () => {
  try {
    stopMonitoring();
    server.close();
  } catch (_err) {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
