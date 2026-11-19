const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const directory = "../com.arkamax404.ulanzi.gentleemote.ulanziPlugin/property-inspector/display/";

function inspector() {
  const html = readFileSync(require.resolve(`${directory}inspector.html`), "utf8");
  assert.match(html, /<input\b[^>]*name="backgroundColor"[^>]*type="color"[^>]*value="#000000"/);
  const handlers = {};
  const events = {};
  const sent = [];
  const form = { elements: { port: { value: "8003" }, scaleMode: { value: "pixel" }, backgroundColor: { value: "#000000" } }, addEventListener: (name, callback) => { events[name] = callback; } };
  const nodes = { "#settings": form, "#status": {}, "#push-url": {} };
  vm.runInNewContext(readFileSync(require.resolve(`${directory}inspector.js`), "utf8"), {
    document: { querySelector: (selector) => nodes[selector] },
    $UD: { on: (name, callback) => { handlers[name] = callback; }, connect: () => {}, sendParamFromPlugin: (settings) => sent.push(JSON.parse(JSON.stringify(settings))) },
  });
  return { form, handlers, events, sent, nodes };
}
test("inspector restores and saves per-key colour alongside existing port and scale", () => {
  const { form, handlers, events, sent, nodes } = inspector();
  handlers.connected();
  handlers.add({ param: { port: 8123, scaleMode: "fill", backgroundColor: "#ABCDEF" } });
  assert.equal(form.elements.backgroundColor.value, "#abcdef");
  assert.equal(form.elements.port.value, "8123");
  assert.equal(form.elements.scaleMode.value, "fill");
  handlers.paramfromapp({ param: { port: 8124 } });
  assert.equal(form.elements.backgroundColor.value, "#abcdef");
  form.elements.backgroundColor.value = "#204060";
  events.change();
  assert.deepEqual(sent, [{ port: 8124, scaleMode: "fill", backgroundColor: "#204060" }]);
  assert.equal(nodes["#push-url"].textContent, "http://127.0.0.1:8124/emote");
  handlers.didReceiveSettings({ settings: { backgroundColor: "invalid" } });
  assert.equal(form.elements.backgroundColor.value, "#000000");
  form.elements.port.value = "0";
  events.input();
  assert.equal(nodes["#push-url"].textContent, "http://127.0.0.1:<free port>/emote");
});
