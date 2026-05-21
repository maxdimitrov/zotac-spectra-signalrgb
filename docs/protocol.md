# Phase 0 Discovery - Findings and Decision

**Date:** 2026-05-22
**Decision: NO-GO** - a SignalRGB plugin for this GPU is not achievable.

## Target

ZOTAC GAMING GeForce RTX 3090 Ti AMP Extreme Holo, SPECTRA 2.0 RGB.
PCI IDs: vendor 0x10DE, device 0x2203, subsystem 0x19DA:0x4666.

## What was tested

1. **OpenRGB 1.0rc2** (with the PawnIO driver installed) registered the GPU
   I2C interface (`Nvidia NvAPI I2C on GPU 0`, Device 10DE:2203 Subsystem
   19DA:4666). A full SMBus-detector address scan of that bus found no
   devices. A direct read of address 0x67 (the usual ENE RGB-controller
   address) returned all-0xFF - no device.

2. **Custom NvAPI port sweep** (`tools/nvapi_i2c_sweep.cs`) probed every
   NvAPI I2C port (0-15) at every address (0x08-0x77), because OpenRGB only
   checks one port. Result: every non-DDC `NvAPI_I2CRead` returned
   **NVAPI_NOT_SUPPORTED (-104)**. This is not "no device acknowledged" -
   the driver rejects the I2C call itself. Zero responders.

## Conclusion

The NVIDIA driver does not expose NvAPI I2C access for this GPU model.
NvAPI I2C is the only mechanism a SignalRGB (or OpenRGB) plugin has to
reach an NVIDIA GPU's RGB controller. A SignalRGB plugin can only talk to
hardware over I2C/SMBus or USB-HID, and the SPECTRA controller is reachable
by neither:

- I2C/SMBus via NvAPI -> NVAPI_NOT_SUPPORTED.
- USB-HID -> the controller is not a HID device (it would otherwise show up
  as an unknown HID device; it does not).

ZOTAC FireStorm still controls the lighting because it uses a lower-level
path (a vendor kernel driver / direct GPU register access) that a sandboxed
SignalRGB JavaScript plugin categorically cannot replicate.

This is an architectural dead end, not a matter of additional effort.

## Recommendation

Control the GPU lighting with ZOTAC FireStorm. Since it cannot be synced
with SignalRGB, set it once to a static color that complements the
SignalRGB theme, then close FireStorm (the color persists). Everything else
- fans, and the RGB strip via a separate USB ARGB controller - stays on
SignalRGB.

## Reusable artifact

`tools/nvapi_i2c_sweep.cs` is a standalone diagnostic that sweeps all NvAPI
I2C ports on any NVIDIA GPU and reports responders and status codes. It is
useful for anyone checking whether a given GPU's RGB controller is reachable
via NvAPI I2C at all.
