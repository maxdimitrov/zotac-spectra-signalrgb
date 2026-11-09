# Zotac SPECTRA - Phase 0: Controller Discovery - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement code plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan is an exception:** Phase 0 is interactive hardware investigation - running a GUI tool (OpenRGB) and physically observing the GPU. It cannot be delegated to a subagent. It is executed inline, with the user driving OpenRGB and Claude interpreting results. Phase 1 (the plugin code) will be a separate, subagent-suitable plan written after this plan's decision gate.

**Goal:** Identify the Zotac RTX 3090 Ti AMP Extreme Holo's RGB controller - its I2C address, chip family, and color-write protocol - and make a documented go/no-go decision for building the SignalRGB plugin.

**Architecture:** Read-only I2C investigation using OpenRGB as a diagnostic tool. No plugin code is written in this phase. Output is `docs/protocol.md` plus a recorded decision.

**Tech Stack:** OpenRGB (diagnostic only), Windows SMBus/I2C, ZOTAC FireStorm (used as a controlled color source for register diffing).

---

## Task 1: Get OpenRGB (portable)

**Files:** none (creates a tools folder)

- [ ] **Step 1: Close FireStorm**

Exit ZOTAC FireStorm completely (system tray icon -> Exit). Open Task Manager and confirm no `FireStorm.exe` process remains. This frees the I2C bus so it does not fight OpenRGB.

- [ ] **Step 2: Download OpenRGB portable**

Open https://openrgb.org/ -> Downloads -> "Windows 64-bit (Portable)". Save the `.zip`.

- [ ] **Step 3: Extract**

Extract the zip to `%USERPROFILE%/Tools/OpenRGB\`.

- [ ] **Step 4: Verify**

Confirm `%USERPROFILE%/Tools/OpenRGB\OpenRGB.exe` exists.
Expected: file present.

## Task 2: First launch with hardware access

**Files:** none

- [ ] **Step 1: Run elevated**

Right-click `OpenRGB.exe` -> Run as administrator. SMBus/I2C access needs admin plus OpenRGB's bundled low-level driver.

- [ ] **Step 2: Allow prompts**

Approve any UAC / SmartScreen prompt.

- [ ] **Step 3: Confirm launch**

Confirm the OpenRGB main window opens with no fatal "driver failed" error. It is fine if few or zero RGB devices are detected - only the I2C tools are needed.
Expected: OpenRGB window open, running elevated.

## Task 3: Find the NVIDIA GPU I2C bus

**Files:** none

- [ ] **Step 1: Open I2C tools**

In OpenRGB, open the "I2C Tools" tab (may be labeled "SMBus/I2C Tools" depending on version).

- [ ] **Step 2: Inspect the bus list**

Open the bus selector dropdown. It lists every detected SMBus/I2C bus. Entries naming "NVIDIA", "GA102", or a PCI path containing `10DE` are the GPU's I2C bus(es). Motherboard SMBus entries (Intel/ITE) are not relevant - ignore them.

- [ ] **Step 3: Record bus names**

Write down the exact name of each NVIDIA GPU bus entry. There may be more than one (the card can expose several I2C buses).

## Task 4: Scan the GPU bus for responding addresses

**Files:** none

- [ ] **Step 1: Select a GPU bus**

In the bus dropdown, select the first NVIDIA GPU bus.

- [ ] **Step 2: Run the detector**

Click "Detect" / run the I2C Detector. It probes addresses 0x03-0x77 and shows a grid of which respond.

- [ ] **Step 3: Record responders**

Record every responding address. Repeat Steps 1-3 for each NVIDIA GPU bus found in Task 3.

- [ ] **Step 4: Note the outcome**

- One or more addresses respond -> candidate controller(s); continue to Task 5.
- Nothing responds on any GPU bus -> record this clearly; it points to the controller not being on the host-accessible I2C bus, which feeds the no-go path in Task 8.
Expected: typically one address in the 0x40-0x70 range responds.

## Task 5: Dump registers from each candidate address

**Files:** `docs/protocol.md` (created)

- [ ] **Step 1: Dump registers**

In I2C Tools, use the SMBus Dump / register read on a responding address. Read registers 0x00 through 0xFF.

- [ ] **Step 2: Save the dump**

Paste the full hex dump into `docs/protocol.md` under a "Raw register dump" heading, labeled with the address.

- [ ] **Step 3: Look for ID strings**

Scan the dump for readable ASCII. ENE controllers expose a device-name string. Note any readable text and its register offset.

- [ ] **Step 4: Repeat**

Repeat Steps 1-3 for every responding address from Task 4.

## Task 6: Identify the chip and locate the color registers (register diff)

**Files:** `docs/protocol.md` (appended)

This is the key task. The chip and its color registers are found by making FireStorm change the color and observing which registers move.

- [ ] **Step 1: Set RED**

Open ZOTAC FireStorm. Set GPU lighting to solid RED, apply.

- [ ] **Step 2: Dump (red)**

In OpenRGB I2C Tools, dump the candidate address registers. Save in `docs/protocol.md` as "dump - red".

- [ ] **Step 3: Set GREEN, dump**

In FireStorm set solid GREEN, apply. Dump again. Save as "dump - green".

- [ ] **Step 4: Set BLUE, dump**

In FireStorm set solid BLUE, apply. Dump again. Save as "dump - blue".

- [ ] **Step 5: Diff for color registers**

Compare the three dumps. Registers that read high for red / low for green+blue (and rotate correspondingly) are the R/G/B color registers. Record their offsets and the apparent byte order.

- [ ] **Step 6: Diff for the mode register**

In FireStorm set a hardware effect (e.g. breathing), apply, dump. Then set static, apply, dump. The register that differs is the mode/direct register. Record its offset and the value meaning "static/direct".

- [ ] **Step 7: Identify the chip family**

Cross-reference the ID strings (Task 5) and the register layout against OpenRGB's source (`Controllers/ENESMBusController`, `Controllers/ITESMBusController`, and GPU controller directories). Record the matched chip family, or "no match - custom protocol".

- [ ] **Step 8: Close FireStorm**

Exit FireStorm so it does not contend for the bus later.

## Task 7: Write and commit docs/protocol.md

**Files:** `docs/protocol.md`

- [ ] **Step 1: Consolidate findings**

Ensure `docs/protocol.md` contains, near the top: NVIDIA GPU bus name(s); responding address(es); the chosen controller address; chip family / identification; the mode/direct register offset and value; the R/G/B color register offsets and byte order; the full write sequence to set one color; a confidence level (high/medium/low). Keep the raw dumps as an appendix.

- [ ] **Step 2: Commit**

```bash
cd <repo root>
git add docs/protocol.md
git commit -m "docs: add Phase 0 SPECTRA controller protocol findings"
```

## Task 8: Decision gate

**Files:** `docs/protocol.md`

- [ ] **Step 1: Evaluate against the gate**

Apply the DESIGN.md decision gate:
- A controller address plus a usable write sequence (mode register + color registers) was found -> **GO**: proceed to write the Phase 1 plan.
- A controller responds but the protocol is unclear -> **HOLD**: do controlled probing or sniff FireStorm before any Phase 1 work.
- Nothing accessible on the GPU I2C bus -> **NO-GO**: the card's RGB is likely unreachable from the host; reassess scope with the user.

- [ ] **Step 2: Record the decision**

Write the decision (GO / HOLD / NO-GO) and its rationale at the top of `docs/protocol.md`. Commit:

```bash
cd <repo root>
git add docs/protocol.md
git commit -m "docs: record Phase 0 decision gate outcome"
```

- [ ] **Step 3: Hand off**

On **GO**: re-invoke the writing-plans skill to produce the Phase 1 plan, grounded in the discovered protocol. Phase 1 is plugin code and is suitable for subagent-driven execution.
On **HOLD** or **NO-GO**: stop and discuss next steps with the user.
