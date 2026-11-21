# Gentle-Emotex for Ulanzi D200

Gentle-Emotex turns a Ulanzi D200 key into a small screen for the [Gentle-Emotex](https://github.com/arkamax404-max/gentle-emotex)
emitter:
the plugin listens on a local HTTP port and mirrors every avatar frame the emitter sends, so the
key animates together with the terminal. Gentle-Emotex is a fork of
[gentle-emote](https://github.com/efolchmontiel/gentle-emote), and this plugin is that fork's
D200 receiver — it is not the terminal extension itself and it is not an official Gentle Emote or
Ulanzi product.

No account, no cloud, no outbound networking: the receiver binds `127.0.0.1` only.

## Related project

The external emitter lives in the [gentle-emotex](https://github.com/arkamax404-max/gentle-emotex)
repository, the Pi / Gentle Shell extension fork of gentle-emote in this ecosystem. Configure the
emitter's external display output to send avatar frames to this plugin: the emitter runs in the
terminal, while gentle-emote-d200 (the plugin you are reading about) displays the frames on
an Ulanzi D200 key.

## Requirements

- Ulanzi D200 with Ulanzi Studio 2.1.4 or later.
- Windows 10+ or macOS 12+ (declared; no platform-specific code paths, only Node built-ins).
  The plugin has been used on Windows; the macOS support is declared but has not been
  independently verified on a device.
- A compatible external emitter set up for the D200: [Gentle-Emotex](https://github.com/arkamax404-max/gentle-emotex),
  which declares **Node.js >= 20.12.2**, installed in Pi or Gentle Shell with external display
  mirroring configured.

## Install

1. Build the package: `npm run package` (see [Development](#development)); no dependency installation is required.
2. In Ulanzi Studio, install `com.arkamax404.ulanzi.gentleemote.ulanziPlugin/package/com.arkamax404.ulanzi.gentleemote.ulanziPlugin.zip`.
3. Drag **Gentle-Emotex → Emote Display** onto a D200 key.

## Point the emitter at the key

Add the destination to the emitter's config (`config.json` in the extension folder, or the
project-level override):

```json
{
  "externalDisplay": {
    "enabled": true,
    "url": "http://127.0.0.1:8003/emote",
    "timeoutMs": 1000
  }
}
```

The key itself shows the address it is listening on while it waits for the first frame, so the port
never has to be guessed. Reload the extension (`/reload`) and run `/emote d200On` to start mirroring
(the same frame can go to the simulator at 8000 and to this key at 8003 at once).

Multiple destinations are supported upstream, so the D200 can receive frames next to the browser
simulator, which keeps its own port 8000:

```json
{
  "externalDisplay": {
    "enabled": true,
    "timeoutMs": 1000,
    "targets": [
      { "enabled": true, "url": "http://127.0.0.1:8000/emote" },
      { "enabled": true, "url": "http://127.0.0.1:8003/emote" }
    ]
  }
}
```

## Receiver protocol v1

The plugin accepts exactly what gentle-emote sends (`src/external_display.ts`):

| Part | Value |
| --- | --- |
| Method | `POST` |
| `Content-Type` | `image/png` |
| Body | Raw PNG, 64x64 by original design, opaque |
| `X-Emote-Version` | `1` (required) |
| `X-Emote-State` | Selected state, e.g. `think` |
| `X-Emote-Frame` | Selected filename, e.g. `think.png` |
| `X-Emote-Set` | Set directory basename |
| `X-Emote-Status` | `idle`, `busy`, or `error` |
| `X-Emote-Phase` | `idle`, `thinking`, `responding`, `executing`, `waiting`, `compacting` |
| `X-Emote-Active-Subagents` | Nonnegative in-flight subagent count |
| `X-Emote-Session-Id` | Optional opaque session ID, 1–128 characters from `A-Za-z0-9_.:-` |
| `X-Emote-Stream-Id` | Random sender UUID |
| `X-Emote-Sequence` | Decimal sequence; session-aware traffic uses exact unsigned 64-bit comparisons |

Any path is accepted, so only host and port matter. Answers: `204` on success, `405` for a
non-`POST` method (with `Allow: POST`), `415` for a non-PNG body, `400` for a bad version header or an
undecodable PNG, `413` above 256 KiB. Metadata is optional and bounded: an unknown `state`, `status`,
`phase` or `sequence` is reported as absent instead of rejecting a valid frame.

Delivery is latest-frame-only. gentle-emote already drops intermediate animation frames, so the key
always paints the newest selection instead of replaying a backlog.

## Press-to-focus (DEDICATED-SUCCESS-v1)

Pressing a D200 key asks the emitter to focus the Herdr pane for the session shown on that key.
Frames that additionally carry `X-Emote-Session-Id` (≤ 128 chars of
`A-Za-z0-9_.:-`) register a focus-capable identity beside their stream id and sequence; sequences
are compared as exact ASCII decimals (`0007` and `7` are the same number, leading zeros kept out of
the comparison). Pressing a key then queues an opaque request id for exactly the identity the key
currently paints, delivered on the next fresh frame or heartbeat for that identity through the
`X-Emote-Focus-Request-Id` response header; the emitter confirms with `X-Emote-Focus-Ack`.

Two small exact-path routes carry lifecycle traffic (`Content-Type` ignored, empty body required):

| Route | Effect |
| --- | --- |
| `POST /emote/heartbeat` | Refreshes the current stream's 30s lease, reactivates an expired one; never creates or switches streams |
| `POST /emote/close` | Marks the stream closed, clears the pending focus request; only a new stream can take over |

Both answer `204`/`405`/`400` like frames, plus `403` when an `Origin` header is present — origin
bearing traffic is display-only and can never create or change focus state. Bounds mirror the
desktop contract: 32 simultaneously active sessions, 64 known session records (when a 65th is
needed, the inactive record least recently seen is evicted; active records are never evicted), 16
retired stream ids per session (FIFO, a dropped id may return as a brand-new stream), a 30s lease
per session and a 15s TTL per focus request. Replays, retired and closed identities are answered
with an empty `204` that stores, counts, repaints and queues nothing; when 32 sessions are already
active a new activation — a fresh session or a reactivation — is answered `429`, while plain legacy
frames keep working.

## Scaling: 64x64 to the key grid

A D200 key is a 196x196 pixel canvas. A 64x64 frame gets an **exact 3x nearest-neighbour upscale**
(192x192) centred on a black canvas with a 2px letterbox:

- integer factors keep every source pixel the same size, so pixel-art edges stay crisp;
- transparent source pixels are composited over the canvas colour (black and opaque by default, or
  the configured **Background color** and **Background transparency**);
- the background alpha composites source-over: opaque frame pixels never fade, and the letterbox
  margins carry exactly the configured background alpha (0% opaque … 100% invisible);
- non-square frames keep their aspect ratio on the same integer rule;
- sources larger than the key fall back to a proportional nearest-neighbour downscale;
- the optional **Fill** mode stretches the frame across the whole key when a full-bleed look is wanted.
- the optional **Remove black background** checkbox clears only the pure black pixels connected to
  the image edge (the usual PNG padding) before scaling, so interior black details are kept; the
  cleared area then shows the configured background color and transparency.

Two limitations to know about: black parts of the avatar that touch the background may also
disappear when the removal is on, and the option is **off by default** so the default output stays
exactly as before — enable it per key and revert it at any time.

Limitation: the background color and transparency live behind the emote. Transparent areas of the
received PNG (and the margins) show it, but **opaque pixels in the received PNG are not replaced** —
the key paints whatever alpha the payload carries, and real alpha rendering on the D200 hardware
depends on Ulanzi Studio (not verified on device here).

gentle-emote already draws the status/phase labels into the PNG it sends, so no text is redrawn here.

## Ports

The default port is **8003**, matched to `/emote d200On` in gentle-emote, and chosen to keep out of
the way of the rest of the ecosystem:

| Destination | Port |
| --- | --- |
| This D200 plugin | 8003 (default, `/emote d200On`) |
| `emote-display-simulator` (browser preview) | 8000 |
| ESP32 display firmware | 80 (`POST /emote`, `GET /health`) |

Port `0` asks the system for a free port; an OS-chosen port is shown on the key once it is bound.
Fixed configured ports are strict: the receiver binds exactly the port you set and never switches
on its own. When a fixed port is already taken (a second instance or another tool), the keys on
that port show a clear `PORT IN USE` error with the configured address instead of a frame — no
stale image, no silent fallback — and the receiver for other port groups keeps working. Free the
port (or reconfigure the key) and the affected keys recover on the next settings change.

## Settings

Per key, from the Property Inspector:

- **Local port** — `0` to let the system pick a free port, otherwise an exact fixed port 1-65535;
  a taken fixed port is reported as a visible key error, never auto-replaced.
- **Scaling** — `Pixel` (3x, default) or `Fill`.
- **Background color** — `#rrggbb` behind the emote and the waiting placeholder (default black).
- **Background transparency** — 0% (opaque, default) to 100% (fully transparent background); it also
  applies to the placeholder shown before any frame arrives.
- **Remove black background** — off by default; when enabled, edge-connected pure black
  (`RGB 0,0,0`) pixels are treated as background. Black avatar regions joined to the background may
  also be removed.

Several keys can be placed at once, grouped by their configured port: keys sharing a port mirror
one receiver's newest frame, while keys on different ports are fully independent — their own
receiver, frame, focus queue and render cache. A key's port change drops the old receiver's frame
and focus association, and a port group's receiver stops as soon as its last key is removed or
re-pointed. Pressing a key requests focus for the session shown on that key, routed through that
key's own port group.

## Key press

Pressing the key redraws the newest frame and requests focus for its last displayed session when
valid session metadata is available. The emitter must support DEDICATED-SUCCESS-v1 and be reloaded
after its D200 focus update. Legacy frames remain display-only; pressing never changes key settings.
The emitter acknowledges only confirmed focus success. Selecting a Herdr pane does not necessarily
bring the terminal window to the foreground.

## Development

```bash
npm test      # node:test suite: PNG codec, scaler, protocol, receiver, key runtime
npm run build # copy src/plugin -> plugin dist/, regenerate the key icons
npm run package
```

Layout:

```text
src/plugin/png.js            PNG decode/encode on node:zlib (no dependencies)
src/plugin/scale.js          64x64 -> 196x196 key rendering
src/plugin/emote-protocol.js protocol v1 parsing and validation
src/plugin/emote-server.js   loopback HTTP receiver, one strict receiver per configured port
src/plugin/host-client.js    zero-dependency WebSocket client for Ulanzi Studio
src/plugin/main.js           key runtime wiring
com.arkamax404.ulanzi.gentleemote.ulanziPlugin/
                             manifest, assets, inspector and built dist
```

## Store package and assets

The publication package is built with `npm run package` into
`com.arkamax404.ulanzi.gentleemote.ulanziPlugin/package/com.arkamax404.ulanzi.gentleemote.ulanziPlugin.zip`
(plugin folder at the ZIP root). Publication assets prepared for the Ulanzi community store:

| Asset | Where | Ratio / size |
| --- | --- | --- |
| Store banner (packaged, referenced by manifest `Banner`) | `assets/banners/banner-1.png` | 3:2 (1536x1024) |
| Store cover (upload form only, not packaged) | approved source artwork, `assets/store/cover.png` | 2:1 (1774x887) |
| Plugin/icon assets | `assets/plugin.png`, `assets/action.png` | 196x196 PNG |
| License | `LICENSE` (upstream copyright notices preserved) | MIT |

The raw working references for the approved art (`com.arkamax404.ulanzi.gentleemote.ulanziPlugin/assets/store/reference/`)
are inputs only and are excluded from the package by the packaging script — the originals are never
deleted or moved.

For URL-based community store discovery, the repository root also exposes optional
[`store.json`](store.json) metadata pointing at the approved store assets — `assets/store/cover.png`
(cover), `assets/store/banner.png` (screenshot/banner) — plus the listing description and the
D200 device tags. It is description only and is not packaged, required at install time, or read by
the plugin runtime.

Outstanding confirmation: the official UGC upload guide is contradictory about the cover ratio — its
initial table lists a 1:1 cover while its final text requires 2:1. This package uses a 2:1 cover and
a 3:2 banner accordingly, but the live UGC upload form's Auto check is the authoritative source and
has **not** been run yet; run it before submission and re-export the cover if the form asks for a
1:1 image.

## Security

The protocol has no authentication and travels over plain HTTP, so the receiver binds loopback only.
Do not expose it to a network, and keep the sender configuration in trusted hands: project-level
gentle-emote config can enable outbound requests.

## Credits

PNG codec and scaler are adapted from gentle-emote's `src/png.ts` and `src/display_image.ts` (MIT).
The Ulanzi host client and the build/package scripts follow the sibling D200 plugins in this
workspace. gentle-emote is built on [pi-emote](https://github.com/cgxeiji/pi-emote) by Eiji Onchi.
The publication package serves the Gentle-Emotex fork of gentle-emote; both upstream projects keep
full credit.

## License

[MIT](LICENSE). Upstream copyright notices are preserved in the license.
