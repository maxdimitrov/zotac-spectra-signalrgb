# SPECTRA 2.0 Controller - Access Path and Protocol

**Updated:** 2026-11-06
**Decision: GO** - the controller is reachable from user-mode code and a live
colour write has been verified on the card. This reverses the 2026-05-22
NO-GO (see "History" below).

## Target

ZOTAC GAMING GeForce RTX 3090 Ti AMP Extreme Holo, SPECTRA 2.0 RGB.
PCI IDs: vendor 0x10DE, device 0x2203, subsystem 0x19DA:0x4666.

## How the access path was found

ZOTAC FireStorm 3.0.0.040E (`C:\Program Files (x86)\ZotacFireStorm\FireStorm.exe`,
32-bit) ships no kernel driver and imports no `DeviceIoControl` / WinRing0.
It resolves NvAPI functions through `nvapi_QueryInterface`. Running it under
Frida with `tools/nvapi_hook.js` (launcher `tools/run-trace.ps1`) logged
every NvAPI call while the lighting was changed in the UI. Capture:
`captures/2026-11-06-firestorm-trace.log`.

## Bus parameters

| Field | Value |
|---|---|
| NvAPI calls | public `NvAPI_I2CWrite` (0xE812EB07) / `NvAPI_I2CRead` (0x2FDE12C5) |
| Struct | `NV_I2C_INFO_V3` |
| `bIsDDCPort` | **1** |
| `displayMask` | **1** |
| `portId` / `bIsPortIdSet` | 1 / 1 |
| `i2cSpeed` / `i2cSpeedKhz` | 0xFFFF / 4 (100 kHz) |
| Address | 0x49 (7-bit; 0x92 in the struct) |
| Admin rights | not required |

FireStorm also probes 0x48 (fails) and uses an invalid GPU handle on some
early calls (status -101); both are noise.

## Registers and commands

**Identify:** raw write (no register phase) `a0 f1 00 00 00 00 00 00`, then read
32 bytes from reg 0xA0 -> ASCII `N666E-1017`.

**Read stored config:** raw write `a0 f0 00 00 00 <idleActive> <zone> 00`, then
read 32 bytes from reg 0xA0. idleActive 0-1, zone 0-6. FireStorm uses zone 5.
Readback byte 2 is 0x01 where the write packet has 0x00.

**Set config (live):** write 30 bytes to reg 0xA0. Field names from OpenRGB's
`ZotacV2GPUController`, which speaks the same protocol:

```
off  field         value
 0   on            01 (00 = off)
 1   reset         00 (01 seen once, followed by reg 0xA2 = 01)
 2-3               00 00
 4   idleActive    1 = config shown while the GPU is active, 0 = while idle
 5   zone          05 (FireStorm)
 6   mode          00 static, 01 breath, 02 fade, 03 wink, 04 flash,
                   05 shine (sound), 06 random, 07 slide, 08 rainbow,
                   09 marquee, 0a drip, 0b dance (sound), 17 duet, 18 path
 7-9 colour1       R G B
10   speed         0x00-0x64
11   brightness    0x00-0x64
12   direction
13                 varies; unknown
14   syncMode      01 (00 = card stops following colour1; see below)
15   circuit       00 / 01
16-18 colour2      R2 G2 B2 (two-colour effects)
19   colorPreset
20-29              00
```

The write takes effect immediately; no commit write is needed.

**Zones** (verified 2026-11-07 by writing a different static colour to each,
syncMode 0): 0 = side stripes (24 LEDs), 1 = side ZOTAC GAMING logo (4),
2 = backplate stripes (~23-24), 3 = backplate claw logo (4), 4 = nothing
visible (likely the external ARGB header),
5 = all zones synchronized (with syncMode 1; what FireStorm writes). Each zone
is one colour; none is addressable. LED counts come from filming mode 0x07
(slide, white, speed 0x10) one zone at a time (`zotac_ddc slidetest`): the
light advances one LED per ~180 ms and one cycle is 2N+2 steps (fill, empty,
2-step gap), which also counts LEDs hidden behind cables. Same layout as OpenRGB's table entry
`{4 zones, external strip}` for the RTX 3090 AMP Extreme Holo.

**Idle vs active:** the controller switches between the idleActive=1 and
idleActive=0 configs by itself (idle config while the GPU idles). This card's
stored idle config had brightness 0, so writing only the active config left the
card dark whenever it went idle. Write every colour to both.

**Every 0xA0 write can black the card out for ~40 ms** (2-3 frames at 60 fps).
Measured on video 2026-11-07, 120 updates per run at 0.5 s: rainbow 7
blackouts, the identical green packet re-sent 3, syncMode=0 rainbow 9 (and the
card ignored colour1, holding light blue). Earlier 5/2/1/0.5 s run: 4 of ~56
writes, at every rate. So the rate is ~2-6% per update, independent of write
rate and of whether the colour changes. There is no direct/per-frame mode; the
plugin writes only when the effect colour has settled.

**Not used by our tooling:**
- reg 0xA2 = 01 (written twice by FireStorm; assumed save-to-flash).
- reg 0xA3, 1 byte, streamed at ~62 Hz from the moment FireStorm selected
  mode 0x0b (dance, sound activated) until it closed: the audio level for
  the sound modes (always 00 in the capture, nothing was playing). Not a
  colour path.
- raw `b8` / `b0` single-byte writes followed by 1-byte reads (status poll).

## Verified

`tools/zotac_ddc.cs` (x64, unelevated, FireStorm closed) reads the id,
dumps all configs, and wrote static green (idleActive=1): the card changed live.
Restored to the pre-test config afterwards. State before the test:
`captures/2026-11-06-state-before-replay.txt`.

## History

The 2026-05-22 NO-GO was based on `tools/nvapi_i2c_sweep.cs` getting
`NVAPI_NOT_SUPPORTED` (-104) on every port. That sweep used
`displayMask = 0`; the DDC pass needs `displayMask = 1`. The guess that
FireStorm used a vendor kernel driver was wrong.

## SignalRGB

Answered 2026-11-07: SignalRGB's own SMBUS bus reaches the controller (the
identify query returns `N666E-1017` through it), and `bus.WriteBlock(0xA0,
30, data)` lands aligned, with no SMBus length byte. No helper process is
needed. Plugin: `plugin/Zotac_Spectra_GPU.js`.
