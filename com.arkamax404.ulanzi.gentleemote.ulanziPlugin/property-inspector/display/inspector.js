const ACTION_UUID = "com.arkamax404.ulanzi.gentleemote.display";
const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const pushUrl = document.querySelector("#push-url");
const transparencyValue = document.querySelector("#transparency-value");
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
let settings = { port: 8003, scaleMode: "pixel", backgroundColor: "#000000", backgroundTransparency: 0, removeBlackBackground: false };

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
form.addEventListener("input", () => {
  renderPushUrl();
  renderTransparency();
});
form.addEventListener("change", () => saveSettings());

function saveSettings() {
  const enteredPort = form.elements.port.value.trim();
  const enteredColor = form.elements.backgroundColor.value;
  const enteredTransparency = Number(form.elements.backgroundTransparency.value);
  settings = {
    port: enteredPort === "" ? settings.port : Number(enteredPort),
    scaleMode: form.elements.scaleMode.value || settings.scaleMode,
    backgroundColor: HEX_COLOR.test(enteredColor) ? enteredColor : settings.backgroundColor,
    backgroundTransparency: Number.isInteger(enteredTransparency) && enteredTransparency >= 0 && enteredTransparency <= 100
      ? enteredTransparency
      : settings.backgroundTransparency,
    removeBlackBackground: form.elements.removeBlackBackground.checked === true,
  };
  $UD.sendParamFromPlugin(settings);
  applySettings();
  status.textContent = "Saved. The key shows the port in use.";
}

function applySettings() {
  form.elements.port.value = String(settings.port);
  form.elements.scaleMode.value = settings.scaleMode;
  form.elements.backgroundColor.value = HEX_COLOR.test(settings.backgroundColor) ? settings.backgroundColor : "#000000";
  form.elements.backgroundTransparency.value = String(
    Number.isInteger(settings.backgroundTransparency) && settings.backgroundTransparency >= 0 && settings.backgroundTransparency <= 100
      ? settings.backgroundTransparency
      : 0,
  );
  form.elements.removeBlackBackground.checked = settings.removeBlackBackground === true || settings.removeBlackBackground === "true";
  renderPushUrl();
  renderTransparency();
}

function renderPushUrl() {
  const entered = Number(form.elements.port.value.trim());
  const port = Number.isInteger(entered) && entered >= 0 && entered <= 65535 ? entered : settings.port;
  pushUrl.textContent = port === 0
    ? "http://127.0.0.1:<free port>/emote"
    : `http://127.0.0.1:${port}/emote`;
}

function renderTransparency() {
  transparencyValue.textContent = `${form.elements.backgroundTransparency.value}%`;
}

$UD.connect(ACTION_UUID);
