const ACTION_UUID = "com.arkamax404.ulanzi.gentleemote.display";
const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const pushUrl = document.querySelector("#push-url");
let settings = { port: 8000, scaleMode: "pixel" };

$UD.on("connected", () => {
  status.textContent = "Settings are stored with this key.";
  renderPushUrl();
});
for (const event of ["add", "paramfromapp", "didReceiveSettings"]) {
  $UD.on(event, (message) => {
    const incoming = message.param || message.settings;
    if (!incoming) return;
    settings = { ...settings, ...incoming };
    applySettings();
  });
}
form.addEventListener("input", () => renderPushUrl());
form.addEventListener("change", () => saveSettings());

function saveSettings() {
  const enteredPort = form.elements.port.value.trim();
  settings = {
    port: enteredPort === "" ? settings.port : Number(enteredPort),
    scaleMode: form.elements.scaleMode.value || settings.scaleMode,
  };
  $UD.sendParamFromPlugin(settings);
  applySettings();
  status.textContent = "Saved. The key shows the port in use.";
}

function applySettings() {
  form.elements.port.value = String(settings.port);
  form.elements.scaleMode.value = settings.scaleMode;
  renderPushUrl();
}

function renderPushUrl() {
  const entered = Number(form.elements.port.value.trim());
  const port = Number.isInteger(entered) && entered >= 0 && entered <= 65535 ? entered : settings.port;
  pushUrl.textContent = port === 0
    ? "http://127.0.0.1:<free port>/emote"
    : `http://127.0.0.1:${port}/emote`;
}

$UD.connect(ACTION_UUID);
