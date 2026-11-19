# Gentle Emote for Ulanzi D200

A Ulanzi D200 key that becomes a small screen for [gentle-emote](https://github.com/efolchmontiel/gentle-emote):
the plugin listens on a local HTTP port and mirrors every avatar frame the extension sends, so the
key animates together with the terminal.

No account, no cloud, no outbound networking: the receiver binds `127.0.0.1` only.

## Related project

[gentle-emotex](https://github.com/arkamax404-max/gentle-emotex) is the related Pi / Gentle Shell
extension repository in this ecosystem. Configure its external display output to send avatar frames
to this plugin: gentle-emotex runs in the terminal, while gentle-emote-d200 displays the frames on
an Ulanzi D200 key. This plugin is a separate receiver, not the terminal extension.

## Requirements

- Ulanzi D200 with Ulanzi Studio 2.1.4 or later.
- Windows 10+ or macOS 12+ (no platform-specific code paths; only Node built-ins).
- gentle-emote installed in Pi or Gentle Shell, with external display mirroring configured.

## Install

1. Build the package: `npm run package` (see [Development](#development)); no dependency installation is required.
2. In Ulanzi Studio, install `com.arkamax404.ulanzi.gentleemote.ulanziPlugin/package/com.arkamax404.ulanzi.gentleemote.ulanziPlugin.zip`.
3. Drag **Gentle Emote → Emote Display** onto a D200 key.

## Point gentle-emote at the key

Add the destination to gentle-emote's config (`config.json` in the extension folder, or the
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
| `X-Emote-Stream-Id` | Random sender UUID |
| `X-Emote-Sequence` | Increasing positive integer |

Any path is accepted, so only host and port matter. Answers: `204` on success, `405` for a
non-`POST` method (with `Allow: POST`), `415` for a non-PNG body, `400` for a bad version header or an
undecodable PNG, `413` above 256 KiB. Metadata is optional and bounded: an unknown `state`, `status`,
`phase` or `sequence` is reported as absent instead of rejecting a valid frame.

Delivery is latest-frame-only. gentle-emote already drops intermediate animation frames, so the key
always paints the newest selection instead of replaying a backlog.

## Scaling: 64x64 to the key grid

A D200 key is a 196x196 pixel canvas. A 64x64 frame gets an **exact 3x nearest-neighbour upscale**
(192x192) centred on a canvas (black by default) with a 2px letterbox:

- integer factors keep every source pixel the same size, so pixel-art edges stay crisp;
- transparent source pixels are composited over the canvas colour (black by default);
- non-square frames keep their aspect ratio on the same integer rule;
- sources larger than the key fall back to a proportional nearest-neighbour downscale;
- the optional **Fill** mode stretches the frame across the whole key when a full-bleed look is wanted.

gentle-emote already draws the status/phase labels into the PNG it sends, so no text is redrawn here.

## Ports

The default port is **8003**, matched to `/emote d200On` in gentle-emote, and chosen to keep out of
the way of the rest of the ecosystem:

| Destination | Port |
| --- | --- |
| This D200 plugin | 8003 (default, `/emote d200On`) |
| `emote-display-simulator` (browser preview) | 8000 |
| ESP32 display firmware | 80 (`POST /emote`, `GET /health`) |

Port `0` asks the system for a free port. When the configured port is already taken (a second
instance or another tool), the next free port of the series is used and the key shows the port
actually bound — the plugin never fails, and it never steals the simulator's 8000 unless you ask for
it explicitly.

## Settings

Per key, from the Property Inspector:

- **Local port** — `0` for automatic, otherwise 1-65535.
- **Scaling** — `Pixel` (3x, default) or `Fill`.
- **Background color** — per-key RGB color picker, black (`#000000`) by default. Stored with
  the key in Ulanzi Studio; six-digit `#rrggbb` values are normalized to lowercase and missing or
  invalid values fall back to black. Changes redraw the current frame immediately and also color
  the waiting placeholder, without changing its text or accent.

The background fills the D200 letterbox and composites transparent/partially transparent received
pixels to an opaque key image. Opaque source pixels (including black pixels and padding already
baked into the sender's PNG) are unchanged; a fully opaque frame in **Fill** mode may show no
background at all. Source frames are not modified. This is D200 receiver-only: it does not change
sender settings, desktop preferences, or LED display rendering via HTML or serial.

Several keys can be placed at once: they all mirror the same newest frame, and the most recently
applied port wins because one receiver serves the whole plugin.

## Key press

There is no key behaviour yet (by design): pressing the key only redraws the newest frame. Nothing is
sent back to gentle-emote, and no settings change.

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
src/plugin/emote-server.js   loopback HTTP receiver with port fallback
src/plugin/host-client.js    zero-dependency WebSocket client for Ulanzi Studio
src/plugin/main.js           key runtime wiring
com.arkamax404.ulanzi.gentleemote.ulanziPlugin/
                             manifest, assets, inspector and built dist
```

## Security

The protocol has no authentication and travels over plain HTTP, so the receiver binds loopback only.
Do not expose it to a network, and keep the sender configuration in trusted hands: project-level
gentle-emote config can enable outbound requests.

## Credits

PNG codec and scaler are adapted from gentle-emote's `src/png.ts` and `src/display_image.ts` (MIT).
The Ulanzi host client and the build/package scripts follow the sibling D200 plugins in this
workspace. gentle-emote is built on [pi-emote](https://github.com/cgxeiji/pi-emote) by Eiji Onchi.
See also the related [gentle-emotex repository](https://github.com/arkamax404-max/gentle-emotex).

## License

[MIT](LICENSE). Upstream copyright notices are preserved in the license.
