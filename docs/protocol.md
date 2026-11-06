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

**Read stored config:** raw write `a0 f0 00 00 00 <zone> <slot> 00`, then read
32 bytes from reg 0xA0. Zones 0-1, slots 0-6. Slot 5 is the active config.
Readback byte 2 is 0x01 where the write packet has 0x00.

**Set config (live):** write 30 bytes to reg 0xA0:

```
off  value
 0   01            (00 seen once; meaning unknown)
 1   00            (01 seen once, followed by reg 0xA2 = 01; maybe sync/save)
 2-3 00 00
 4   zone          0 or 1 (see zone map)
 5   05            active slot
 6   mode          00 = static; also seen 01 04 05 06 07 08 09 0a 0b 17 18
 7-9 R G B         primary colour
10   0x00-0x64     slider (speed or brightness, 0-100)
11   00 / 64       second slider or flag
12   01
13   0x00-0x05     varies with colour/mode; unknown
14   01
15   00 / 01       unknown flag
16-18 R2 G2 B2     secondary colour (two-colour effects)
19   01-03         unknown
20-29 00
```

The write takes effect immediately; no commit write is needed.

**Not used by our tooling:**
- reg 0xA2 = 01 (written twice by FireStorm; assumed save-to-flash).
- reg 0xA3 = 00, streamed at ~62 Hz from the moment a software-driven effect
  was selected until FireStorm closed. Probably a frame tick for effects
  FireStorm animates itself. Not needed for static colours.
- raw `b8` / `b0` single-byte writes followed by 1-byte reads (status poll).

## Zone map (observed)

- **Zone 1** = all of the card's visible lighting. Static green on zone 1
  turned the whole card green.
- **Zone 0** = nothing visible on this build (static green there changed
  nothing). Possibly the external ARGB output; unconfirmed.

## Verified

`tools/zotac_ddc.cs` (x64, unelevated, FireStorm closed) reads the id,
dumps all slots, and wrote static green to zone 1: the card changed live.
Restored to the pre-test config afterwards. State before the test:
`captures/2026-11-06-state-before-replay.txt`.

## History

The 2026-05-22 NO-GO was based on `tools/nvapi_i2c_sweep.cs` getting
`NVAPI_NOT_SUPPORTED` (-104) on every port. That sweep used
`displayMask = 0`; the DDC pass needs `displayMask = 1`. The guess that
FireStorm used a vendor kernel driver was wrong.

## Open question for the plugin

Whether a SignalRGB plugin's I2C bus API can address an NVIDIA DDC port
with a display mask. If not, the fallback is a local helper doing exactly
what `zotac_ddc.cs` does, fed by a SignalRGB network (UDP) plugin.
