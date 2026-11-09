# Zotac SPECTRA -> SignalRGB Plugin - Design

**Date:** 2026-05-22
**Status:** Historical. This was the original design. The plan changed as the work went on: the controller sits on NvAPI DDC port 1 (not the SMBus OpenRGB scans), per-zone control shipped, and the plugin file is `plugin/Zotac_Spectra_GPU.js`. See `README.md` and `docs/protocol.md` for the current state.
**Target hardware:** ZOTAC GAMING GeForce RTX 3090 Ti AMP Extreme Holo (SPECTRA 2.0 RGB)

## Goal

Make the GPU's onboard SPECTRA RGB lighting controllable from SignalRGB so it
syncs with the rest of the system's lighting. Today the card's RGB is only
controllable by ZOTAC FireStorm; SignalRGB has no Zotac support of any kind.

## Scope

Phased, "start minimal, extend":

- **Minimal (the committed goal):** SignalRGB drives the whole GPU as a single
  color that follows the active canvas/effect.
- **Extend (stretch, deferred):** per-zone control of the card's individually
  lit areas.

## Background

- The card reports PCI IDs: vendor `0x10DE` (NVIDIA), device `0x2203`
  (GA102 / RTX 3090 Ti), subsystem vendor `0x19DA` (ZOTAC), subsystem device
  `0x4666`. Source: Windows PNP path `PCI\VEN_10DE&DEV_2203&SUBSYS_466619DA`.
- SignalRGB GPU plugins are `SMBUS`-type JavaScript files. They detect a card
  by PCI ID, then read/write the RGB controller over the GPU's I2C/SMBus.
  Reference plugins: `Colorful_Ampere_GPU.js`, `Gigabyte_Gen3_GPU.js`.
- OpenRGB does not appear to support Zotac SPECTRA GPUs, so there is no
  existing reverse-engineering to port directly. The controller's I2C address
  and packet protocol must be derived.
- This makes the project "shell is trivial, protocol is the work."

## Architecture

A single SignalRGB plugin: `Zotac_Ampere_GPU.js`.

- `Type()` -> `"SMBUS"`, `DeviceType()` -> `"gpu"`.
- `Scan(bus)` - guard on `bus.IsNvidiaBus()`, match the PCI ID quad
  (vendor / subvendor / device / subdevice) against a card data table, return
  the RGB controller's I2C address.
- `Initialize()` - put the controller into direct / software mode.
- `Render()` - sample the SignalRGB canvas, write color to the controller.
- `Shutdown()` - apply shutdown / sleep color.
- `ConflictingProcesses()` -> `["FireStorm.exe"]`.
- `ControllableParameters()` - shutdown color, lighting mode (Canvas/Forced),
  forced color, and an RGB color-order selector (RGB/GRB/BGR...) for channel
  swaps.

Card detection is a data table (one row per supported card) so other Zotac
SPECTRA owners can contribute their card's IDs and controller address.

## Phases

### Phase 0 - Discovery (read-only)

1. Install OpenRGB (portable) and run it as administrator.
2. In the I2C Tools tab, locate the NVIDIA GPU I2C bus and run the detector;
   record which addresses respond.
3. Read identifying registers on responding addresses to identify the
   controller chip (ENE controllers expose a readable name string; ITE and
   others have known signatures).
4. Cross-reference the chip family against OpenRGB's source to recover the
   register map: direct-mode register, per-channel color registers, and any
   apply/commit register.

**Output:** controller I2C address, chip identity, and protocol notes written
to `docs/protocol.md`.

**Decision gate:**
- Known chip with a documented protocol -> proceed to Phase 1.
- Responds but protocol unknown -> controlled probing, or sniff FireStorm.
- Nothing accessible -> reassess or shelve.

No plugin code is written until this gate passes.

### Phase 1 - Minimal plugin

Implement `Zotac_Ampere_GPU.js` per the architecture above, driving the whole
GPU as one canvas-synced color. Modeled on `Colorful_Ampere_GPU.js`.

Installed as a SignalRGB local / developer plugin so SignalRGB application
updates (which replace the versioned `app-x.x.x` folder) do not wipe it. The
exact local-plugin mechanism is confirmed at the start of Phase 1.

This satisfies the minimal goal.

### Phase 2 - Per-zone control (deferred)

Identify how many independently addressable zones the controller exposes and
map each to a canvas position. Scoped as a separate effort after Phase 1 works.

## Testing & safety

- Phase 0 is read-only - no write risk.
- Phase 1 first write test: FireStorm closed, user watching the card -
  hardcode red -> green -> blue, confirm the card responds and the color order
  is correct, then wire to the canvas.
- The plugin only ever writes to the one identified controller address; it
  never broadcasts.
- The RGB controller is a separate MCU; the realistic worst case is a confused
  controller cleared by a reboot, not GPU damage.
- FireStorm remains available as the known-good path to restore card lighting.

## Repo layout

```
zotac-spectra-signalrgb/
|-- README.md            what it is, supported cards, install steps
|-- LICENSE              chosen at publish time
|-- Zotac_Ampere_GPU.js  the plugin
|-- docs/
|   |-- DESIGN.md        this document
|   |-- protocol.md      reverse-engineered protocol notes
|-- .gitignore
```

## Licensing

Deferred to publish time. To keep MIT viable, the implementation is
**clean-room**: OpenRGB may be used to learn hardware facts (I2C addresses,
register numbers - not copyrightable), but OpenRGB source code is not copied.
If code is ported directly, the result must be GPLv2.

## Known unknowns

- The controller chip and its protocol (resolved by Phase 0).
- SignalRGB's current local/developer-plugin install mechanism (confirmed at
  Phase 1 start).
- The number of addressable zones (affects Phase 2 only).
