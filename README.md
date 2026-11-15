# ZOTAC SPECTRA 2.0 GPU plugin for SignalRGB

A [SignalRGB](https://signalrgb.com) plugin that controls the onboard RGB of the
**ZOTAC GAMING GeForce RTX 3090 Ti AMP Extreme Holo**, so the card follows your
SignalRGB effects. Until now only ZOTAC FireStorm could control it.

## What you get

- **Four lighting areas**, each its own colour: the side stripes, the side
  ZOTAC GAMING logo, the backplate stripes, and the backplate claw logo.
- **A layout that matches the card**: one canvas point per physical LED
  (24 + 4 on the side, ~24 + 4 on the backplate). Each area shows the average
  of its points.
- **Card Effect**: let the card animate by itself (Slide, Breathing, Marquee,
  Drip, Duet, Rainbow, Path) in the colours SignalRGB gives it, with a
  direction per area, or keep it Static.
- No helper program, no admin rights, no FireStorm needed.

## Install

Quit ZOTAC FireStorm first; both would write to the controller.

**As a SignalRGB add-on (recommended, updates itself):**

[![Add To Installation](https://marketplace.signalrgb.com/resources/add-extension-256.png 'Add to My SignalRGB Installation')](signalrgb://addon/install?url=https://github.com/maxdimitrov/zotac-spectra-signalrgb)

1. Click the button above (or open
   `signalrgb://addon/install?url=https://github.com/maxdimitrov/zotac-spectra-signalrgb`)
   and confirm the install prompt in SignalRGB.
2. Restart SignalRGB when it asks.
3. The card appears as **ZOTAC RTX 3090 Ti AMP Extreme Holo**. Add it to your
   layout.

**Manually:**

1. Download [`plugin/Zotac_Spectra_GPU.js`](plugin/Zotac_Spectra_GPU.js).
2. Copy it into your SignalRGB plugins folder:
   `Documents\WhirlwindFX\Plugins\` (create `Plugins` if it is missing; if your
   Documents folder is on OneDrive, use that one).
3. Restart SignalRGB fully (from the tray icon).

Use one or the other: with both installed, two copies of the plugin claim the
same card.

## Settings

| Setting | What it does |
|---|---|
| Lighting Mode | **Canvas** follows the effect; **Forced** uses one fixed colour. |
| Card Effect | **Static** shows the colour. **Slide**, **Breathing**, **Marquee** and **Drip** animate it on the card. **Duet** chases the two colours at the two ends of each area (or the colour and a dim copy when both ends match). **Rainbow** and **Path** use the card's own colours and ignore SignalRGB's, but turn off while SignalRGB shows black (idle timeout, lights off). |
| Card Effect Speed | 1-100, speed of the card's animation. |
| Direction (one per area) | **Forward** / **Reverse**: which way moving effects flow in that area. |
| Color Updates | How often SignalRGB colour changes reach the card: **Every minute** (default), **Every 5 minutes**, or **Only on setting changes**. Only visible changes that hold still for a second are sent. |
| Shutdown Color | Colour applied when SignalRGB or the PC shuts down. |

## Limits

- **One colour per area.** The controller only accepts a colour per area; it
  has no per-LED command. Fast per-frame effects are reduced to the area
  average.
- **Colour updates are rare on purpose: the card stores each one in flash.**
  The controller keeps every setting it receives through power loss, so each
  colour update is most likely a write to its flash memory, which wears out
  after an unknown number of writes. (This is why SignalRGB never supported
  ZOTAC cards.) The plugin therefore sends at most one update per minute, and
  only visible changes that have settled. For movement, use a **Card Effect**:
  it runs on the card and needs no updates. Rainbow and Path need none at all.
- **Occasional blink on a colour change.** About 2-6% of updates black the
  card out for ~40 ms while the controller applies them.
- **Only this card is supported and tested.** Other ZOTAC SPECTRA 2.0 cards
  speak the same protocol but have different areas; the plugin checks both the
  PCI ids and the controller id (`N666E-1017`) and leaves any other card alone.
- Don't run FireStorm at the same time; both would write to the controller.

## How it works

The SPECTRA 2.0 controller sits on the card's I2C bus behind NVIDIA's DDC port 1
at address `0x49`. It was found by tracing ZOTAC FireStorm's NvAPI calls with
Frida; SignalRGB's own GPU bus reaches it the same way. Each colour is one
30-byte configuration write, sent for both the controller's active and idle
states (it switches between them on its own when the GPU idles). The full
protocol, measurements and history are in [`docs/protocol.md`](docs/protocol.md).

`tools/` holds the research tooling: the Frida trace of FireStorm and
`zotac_ddc.cs`, a small command-line tool that talks to the controller directly
(identify, dump, write, and the blink/LED-count tests).

The plugin only sends packet layouts FireStorm itself sends, and never writes
register `0xA2` (FireStorm's save-to-flash). Writing to hardware over SMBus is at
your own risk.

## Credits

Mode and field names follow OpenRGB's `ZotacV2GPUController`, which drives
related ZOTAC cards. No OpenRGB code is used.

## License

MIT, see [LICENSE](LICENSE).
