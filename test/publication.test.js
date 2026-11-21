const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const PLUGIN = "com.arkamax404.ulanzi.gentleemote.ulanziPlugin";
const ROOT = join(__dirname, "..");
const PLUGIN_DIR = join(ROOT, PLUGIN);
const PLUGIN_UUID = "com.arkamax404.ulanzi.gentleemote";
const ACTION_UUID = "com.arkamax404.ulanzi.gentleemote.display";
/** A valid 1x1 PNG used as the fixture stand-in for the approved store banner bytes. */
const FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Isolated sandbox: the real packaging scripts run against a fixture scaffold, in a
 * temp directory owned by this test. The fixture mirrors the repository layout the
 * scripts expect: scripts/, src/plugin/, LICENSE, assets/store/banner.png and the
 * .ulanziPlugin folder with runtime, references and a raw store reference sentinel.
 */
function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gentle-emotex-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  cpSync(join(ROOT, "scripts", "build.mjs"), join(root, "scripts", "build.mjs"));
  cpSync(join(ROOT, "scripts", "package.mjs"), join(root, "scripts", "package.mjs"));
  cpSync(join(ROOT, "src", "plugin"), join(root, "src", "plugin"), { recursive: true });
  writeFileSync(join(root, "LICENSE"), "Fixture MIT License (stand-in for the approved root LICENSE bytes)\n");
  mkdirSync(join(root, "assets", "store"), { recursive: true });
  writeFileSync(join(root, "assets", "store", "banner.png"), FIXTURE_PNG);

  const plugin = join(root, PLUGIN);
  cpSync(join(PLUGIN_DIR, "manifest.json"), join(plugin, "manifest.json"));
  cpSync(join(PLUGIN_DIR, "en.json"), join(plugin, "en.json"));
  mkdirSync(join(plugin, "dist"));
  writeFileSync(join(plugin, "dist", "main.js"), "// fixture runtime sentinel\n");
  mkdirSync(join(plugin, "assets", "store", "reference"), { recursive: true });
  const RAW_SENTINEL = Buffer.from("raw store reference sentinel: this file must never ship\n");
  writeFileSync(join(plugin, "assets", "store", "reference", "raw-ref-sentinel.png"), RAW_SENTINEL);
  return { root, plugin, RAW_SENTINEL };
}

function runScript(root, script) {
  return execFileSync(process.execPath, [join("scripts", script)], { cwd: root });
}

function runPackage(t, fixture) {
  runScript(fixture.root, "build.mjs");
  runScript(fixture.root, "package.mjs");
  return readZip(readFileSync(join(fixture.root, PLUGIN, "package", `${PLUGIN}.zip`)));
}

/** Minimal reader for the stored (method 0) ZIP format the packaging script writes. */
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(end, -1, "ZIP end-of-central-directory record must exist");
  const count = buffer.readUInt16LE(end + 10);
  let position = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50, "central directory record must be valid");
    const nameLength = buffer.readUInt16LE(position + 28);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const localOffset = buffer.readUInt32LE(position + 42);
    const name = buffer.toString("utf8", position + 46, position + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, buffer.subarray(dataStart, dataStart + compressedSize));
    position += 46 + nameLength + buffer.readUInt16LE(position + 30) + buffer.readUInt16LE(position + 32);
  }
  return entries;
}

test("packaging keeps the plugin folder at the ZIP root with runtime, listing and publication files", (t) => {
  const zip = runPackage(t, createFixture(t));
  for (const entry of zip.keys()) assert.ok(entry.startsWith(`${PLUGIN}/`), `unexpected ZIP root entry: ${entry}`);
  for (const relative of ["manifest.json", "en.json", "dist/main.js", "assets/banners/banner-1.png", "LICENSE"])
    assert.ok(zip.has(`${PLUGIN}/${relative}`), `missing required packaged entry: ${relative}`);
});

test("raw store reference inputs are excluded from the package and never touched on disk", (t) => {
  const fixture = createFixture(t);
  const sentinelPath = join(fixture.plugin, "assets", "store", "reference", "raw-ref-sentinel.png");
  const before = readFileSync(sentinelPath);
  const zip = runPackage(t, fixture);
  assert.ok(readFileSync(sentinelPath).equals(before), "raw reference sentinel must remain untouched on disk");
  for (const entry of zip.keys())
    assert.ok(!entry.includes("assets/store/reference"), `raw reference input must not ship: ${entry}`);
});

test("the packaged banner and LICENSE carry the approved source bytes byte for byte", (t) => {
  const fixture = createFixture(t);
  runScript(fixture.root, "build.mjs");
  const zip = runPackage(t, fixture);
  assert.ok(zip.get(`${PLUGIN}/assets/banners/banner-1.png`).equals(FIXTURE_PNG), "packaged banner must be byte-identical");
  assert.ok(
    zip.get(`${PLUGIN}/LICENSE`).equals(readFileSync(join(fixture.root, "LICENSE"))),
    "packaged LICENSE must be byte-identical to the root LICENSE",
  );
  assert.ok(
    readFileSync(join(fixture.plugin, "assets", "banners", "banner-1.png")).equals(FIXTURE_PNG),
    "the in-tree banner copy must be byte-identical to the approved source",
  );
});

test("the packaged manifest advertises the packaged banner and preserves the stable UUIDs", (t) => {
  const zip = runPackage(t, createFixture(t));
  const manifest = JSON.parse(zip.get(`${PLUGIN}/manifest.json`).toString("utf8"));
  assert.deepEqual(manifest.Banner, ["assets/banners/banner-1.png"]);
  assert.equal(manifest.UUID, PLUGIN_UUID);
  assert.equal(manifest.Actions[0].UUID, ACTION_UUID);
  assert.ok(!/only redraws/i.test(manifest.Detail), "the shipped manifest must not carry the stale unconditional only-redraw claim");
  assert.ok(
    /requests focus for the displayed session when the emitter supports it/i.test(manifest.Detail),
    "the shipped manifest must describe the conditional compatible-emitter focus request",
  );
});

test("the listing manifest is truthful about the D200 receiver role and keeps stable identifiers", () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8"));
  const action = manifest.Actions[0];
  assert.equal(manifest.Name, "Gentle-Emotex");
  assert.equal(manifest.Version, "0.1.0");
  assert.equal(manifest.UUID, PLUGIN_UUID);
  assert.equal(action.UUID, ACTION_UUID);
  assert.deepEqual(manifest.Banner, ["assets/banners/banner-1.png"]);
  assert.ok(existsSync(join(PLUGIN_DIR, "assets", "banners", "banner-1.png")), "manifest Banner path must exist in the package");
  assert.ok(/fork of Gentle-Emote/i.test(`${manifest.Description} ${manifest.Detail}`), "upstream fork attribution must be present");
  assert.ok(/receiver/i.test(manifest.Detail), "the plugin must describe its receiver role");
  assert.ok(!/only redraws/i.test(manifest.Detail), "the unconditional only-redraw press claim is stale and must not return");
  assert.ok(
    /requests focus for the displayed session when the emitter supports it/i.test(manifest.Detail),
    "press behavior must state the conditional compatible-emitter focus request",
  );
  assert.ok(!/official|Gentle AI/i.test(manifest.Description + manifest.Detail), "no fabricated affiliation may appear");
});

test("en.json never promises an automatic port fallback and keeps focus support behind a compatible emitter", () => {
  const en = JSON.parse(readFileSync(join(PLUGIN_DIR, "en.json"), "utf8"));
  assert.equal(en.Name, "Gentle-Emotex");
  assert.ok(!/falls back|automatically switch/i.test(en.Detail), "no automatic port fallback may be promised");
  assert.ok(/PORT IN USE/i.test(en.Detail), "the strict fixed-port busy error must be described");
  assert.ok(/port mirror/i.test(en.Detail), "same-port mirroring must be described");
  assert.ok(/different port/i.test(en.Detail), "independent ports must be described");
  assert.ok(/focus/i.test(en.Detail) && /emitter/i.test(en.Detail), "focus support must require a compatible emitter");
  assert.ok(/fork of Gentle-Emote/i.test(en.Detail), "upstream attribution must match the approved scope");
  assert.ok(!/official|Gentle AI/i.test(en.Detail), "no fabricated affiliation may appear");
});

test("root store metadata exposes the approved store assets and mirrors the en.json detail", () => {
  // RED first: store.json does not exist yet at the repository root.
  assert.ok(existsSync(join(ROOT, "store.json")), "the optional root store metadata file must exist");
  const store = JSON.parse(readFileSync(join(ROOT, "store.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(PLUGIN_DIR, "en.json"), "utf8"));

  assert.deepEqual(Object.keys(store), ["cover", "screenshots", "longDescription", "deviceTypes", "tags"]);

  // Every referenced asset must be the approved PNG, verified by integrity signature and exact dimensions.
  for (const relative of [store.cover, ...store.screenshots]) {
    const png = readFileSync(join(ROOT, relative));
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(png.subarray(0, 8).equals(signature), `referenced store asset must be a valid PNG: ${relative}`);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.ok(width > 0 && height > 0, `referenced store asset must report real dimensions: ${relative}`);
  }
  assert.equal(store.cover, "assets/store/cover.png");
  assert.deepEqual(store.screenshots, ["assets/store/banner.png"]);
  assert.equal(store.cover && readFileSync(join(ROOT, store.cover)).readUInt32BE(16), 1774, "the approved cover must keep its 1774x887 dimensions");
  assert.equal(readFileSync(join(ROOT, store.cover)).readUInt32BE(20), 887, "the approved cover must keep its 1774x887 dimensions");
  assert.equal(readFileSync(join(ROOT, store.screenshots[0])).readUInt32BE(16), 1536, "the approved banner must keep its 1536x1024 dimensions");
  assert.equal(readFileSync(join(ROOT, store.screenshots[0])).readUInt32BE(20), 1024, "the approved banner must keep its 1536x1024 dimensions");

  assert.deepEqual(store.deviceTypes, ["deck"]);
  assert.ok(Array.isArray(store.tags) && store.tags.length > 0 && store.tags.every((tag) => typeof tag === "string" && tag.length > 0), "store tags must be a non-empty list of non-empty strings");
  assert.equal(store.longDescription, en.Detail, "the store long description must reuse the approved en.json Detail verbatim");
});

test("the property inspector is transparent and the action UUID stays in sync with the runtime", () => {
  const css = readFileSync(join(PLUGIN_DIR, "property-inspector", "display", "inspector.css"), "utf8");
  assert.match(css, /body\s*\{[^}]*background:\s*transparent[^;]*;/, "the inspector body must stay transparent");
  const html = readFileSync(join(PLUGIN_DIR, "property-inspector", "display", "inspector.html"), "utf8");
  assert.ok(/<h1[^>]*>Gentle-Emotex<\/h1>/i.test(html), "the visible inspector name must be Gentle-Emotex");
  const inspector = readFileSync(join(PLUGIN_DIR, "property-inspector", "display", "inspector.js"), "utf8");
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8"));
  assert.ok(inspector.includes(`"${ACTION_UUID}"`), "inspector action UUID must match the manifest action UUID");
  assert.equal(manifest.Actions[0].UUID, ACTION_UUID);
});
