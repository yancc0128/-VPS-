const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vpsDesktop", {
  testAdminSsh: (payload) => ipcRenderer.invoke("ssh:test-admin", payload),
  runDeploymentAction: (payload) => ipcRenderer.invoke("ssh:run-deployment-action", payload),
  generateRealityKeys: () => ipcRenderer.invoke("crypto:generate-reality-keys"),
  getAiStatus: () => ipcRenderer.invoke("ai:get-status"),
  saveAiSettings: (payload) => ipcRenderer.invoke("ai:save-settings", payload),
  explainDiagnostics: (payload) => ipcRenderer.invoke("ai:explain-diagnostics", payload)
});
