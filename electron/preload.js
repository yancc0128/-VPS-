const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vpsDesktop", {
  testAdminSsh: (payload) => ipcRenderer.invoke("ssh:test-admin", payload),
  runDeploymentAction: (payload) => ipcRenderer.invoke("ssh:run-deployment-action", payload),
  openSshSession: (payload) => ipcRenderer.invoke("ssh:open-session", payload),
  runSessionStep: (payload) => ipcRenderer.invoke("ssh:run-step", payload),
  cancelSessionStep: (sessionId) => ipcRenderer.invoke("ssh:cancel-step", { sessionId }),
  closeSshSession: (sessionId) => ipcRenderer.invoke("ssh:close-session", { sessionId }),
  previewAction: (payload) => ipcRenderer.invoke("ssh:preview-action", payload),
  // 订阅步骤的流式输出；返回取消订阅函数。
  onStepOutput: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("ssh:step-output", listener);
    return () => ipcRenderer.removeListener("ssh:step-output", listener);
  },
  generateRealityKeys: () => ipcRenderer.invoke("crypto:generate-reality-keys"),
  getAiStatus: () => ipcRenderer.invoke("ai:get-status"),
  saveAiSettings: (payload) => ipcRenderer.invoke("ai:save-settings", payload),
  explainDiagnostics: (payload) => ipcRenderer.invoke("ai:explain-diagnostics", payload)
});
