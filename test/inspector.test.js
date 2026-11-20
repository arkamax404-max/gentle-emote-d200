const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const INSPECTOR = join(
  __dirname,
  "..",
  "com.arkamax404.ulanzi.gentleemote.ulanziPlugin",
  "property-inspector",
  "display",
  "inspector.js",
);

/**
 * Runs the real inspector script against small DOM/$UD stubs: no browser, no deps.
 * The stub form exposes one field per input name; `scaleMode` mimics the radio
 * collection's `.value`. Host messages and saved payloads are captured for assertions.
 */
function createInspector() {
  const sent = [];
  const handlers = new Map();
  const elements = {};
  for (const name of ["port", "scaleMode", "backgroundColor", "backgroundTransparency", "removeBlackBackground"])
    elements[name] = { name, value: "", checked: false };
  const form = {
    elements,
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
  };
  const outputs = {
    "#status": { textContent: "" },
    "#push-url": { textContent: "" },
    "#transparency-value": { textContent: "" },
  };
  const document = { querySelector: (selector) => (selector === "#settings" ? form : outputs[selector]) };
  const $UD = {
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    sendParamFromPlugin: (param) => sent.push(param),
    connect: () => {},
  };
  const emit = (event, message) => {
    for (const handler of handlers.get(event) || []) handler(message);
  };
  const fire = (type) => {
    for (const handler of form.listeners[type] || []) handler();
  };
  const source = readFileSync(INSPECTOR, "utf8");
  vm.runInNewContext(source, { document, $UD });
  return { elements, outputs, emit, fire, sent };
}

test("saved background settings fill the inspector controls", () => {
  const inspector = createInspector();
  inspector.emit("didReceiveSettings", {
    param: { port: 8123, scaleMode: "fill", backgroundColor: "#aabbcc", backgroundTransparency: 37 },
  });
  assert.equal(inspector.elements.port.value, "8123");
  assert.equal(inspector.elements.scaleMode.value, "fill");
  assert.equal(inspector.elements.backgroundColor.value, "#aabbcc");
  assert.equal(inspector.elements.backgroundTransparency.value, "37");
  assert.equal(inspector.outputs["#transparency-value"].textContent, "37%");
});

test("a change event saves the background settings through sendParamFromPlugin", () => {
  const inspector = createInspector();
  inspector.elements.port.value = "8003";
  inspector.elements.scaleMode.value = "pixel";
  inspector.elements.backgroundColor.value = "#ff8800";
  inspector.elements.backgroundTransparency.value = "40";
  inspector.elements.removeBlackBackground.checked = false;
  inspector.fire("change");
  assert.deepEqual({ ...inspector.sent.at(-1) }, {
    port: 8003,
    scaleMode: "pixel",
    backgroundColor: "#ff8800",
    backgroundTransparency: 40,
    removeBlackBackground: false,
  });
});

test("a saved removeBlackBackground setting fills the checkbox and is saved back", () => {
  const inspector = createInspector();
  inspector.emit("didReceiveSettings", { param: { port: 8003, removeBlackBackground: true } });
  assert.equal(inspector.elements.removeBlackBackground.checked, true);
  inspector.elements.port.value = "8003";
  inspector.elements.scaleMode.value = "pixel";
  inspector.elements.backgroundColor.value = "#000000";
  inspector.elements.backgroundTransparency.value = "0";
  inspector.fire("change");
  assert.equal(inspector.sent.at(-1).removeBlackBackground, true);
  inspector.emit("didReceiveSettings", { param: { port: 8003, removeBlackBackground: false } });
  assert.equal(inspector.elements.removeBlackBackground.checked, false);
});

test("an input event keeps the visible percentage in sync while dragging", () => {
  const inspector = createInspector();
  inspector.elements.backgroundTransparency.value = "100";
  inspector.fire("input");
  assert.equal(inspector.outputs["#transparency-value"].textContent, "100%");
  inspector.elements.backgroundTransparency.value = "0";
  inspector.fire("input");
  assert.equal(inspector.outputs["#transparency-value"].textContent, "0%");
});

test("a tampered colour or out-of-range transparency never reaches the saved payload", () => {
  const inspector = createInspector();
  inspector.emit("add", { param: { port: 8003, backgroundColor: "#123456", backgroundTransparency: 20 } });
  inspector.elements.port.value = "8003";
  inspector.elements.scaleMode.value = "pixel";
  inspector.elements.backgroundColor.value = "red";
  inspector.elements.backgroundTransparency.value = "150";
  inspector.fire("change");
  const saved = inspector.sent.at(-1);
  assert.equal(saved.backgroundColor, "#123456");
  assert.equal(saved.backgroundTransparency, 20);
});

test("host parameter updates preserve port, scaling and background settings", () => {
  const inspector = createInspector();
  inspector.emit("add", { param: { port: 8003, backgroundColor: "#abcdef", backgroundTransparency: 30 } });
  inspector.emit("paramfromapp", { param: { port: 0, scaleMode: "fill" } });
  assert.equal(inspector.elements.port.value, "0");
  assert.equal(inspector.elements.scaleMode.value, "fill");
  inspector.elements.port.value = "0";
  inspector.elements.scaleMode.value = "fill";
  inspector.elements.backgroundColor.value = "#abcdef";
  inspector.elements.backgroundTransparency.value = "30";
  inspector.elements.removeBlackBackground.checked = true;
  inspector.fire("change");
  assert.deepEqual({ ...inspector.sent.at(-1) }, {
    port: 0,
    scaleMode: "fill",
    backgroundColor: "#abcdef",
    backgroundTransparency: 30,
    removeBlackBackground: true,
  });
});
