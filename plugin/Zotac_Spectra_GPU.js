// ZOTAC SPECTRA 2.0 GPU lighting for SignalRGB.
// Protocol: docs/protocol.md in github.com/maxdimitrov/zotac-spectra-signalrgb
// (captured from ZOTAC FireStorm; NvAPI DDC port 1, address 0x49).
// Modifying SMBUS plugins is risky; this one only sends packets FireStorm itself sends.
export function Name() { return "ZOTAC SPECTRA 2.0 GPU"; }
export function Publisher() { return "maxdimitrov"; }
export function Type() { return "SMBUS"; }
export function Size() { return [1, 1]; }
export function LedNames() { return vLedNames; }
export function LedPositions() { return vLedPositions; }
export function DeviceType() { return "gpu"; }
export function ImageUrl() { return "https://assets.signalrgb.com/devices/default/gpu.png"; }
/* global
shutdownColor:readonly
LightingMode:readonly
forcedColor:readonly
UpdateStyle:readonly
*/
export function ControllableParameters() {
	return [
		{property:"shutdownColor", group:"lighting", label:"Shutdown Color", description: "Applied when the system or SignalRGB shuts down", min:"0", max:"360", type:"color", default:"#000000"},
		{property:"LightingMode", group:"lighting", label:"Lighting Mode", description: "Canvas follows the active effect, Forced uses a fixed color", type:"combobox", values:["Canvas", "Forced"], default:"Canvas"},
		{property:"forcedColor", group:"lighting", label:"Forced Color", description: "Color used when Lighting Mode is Forced", min:"0", max:"360", type:"color", default:"#009bde"},
		{property:"UpdateStyle", group:"lighting", label:"Update Style", description: "The card blinks briefly on every color update. 'Steady colors' updates when the effect color holds still (and at least every 10 s); 'Every few seconds' follows any effect every 3 s", type:"combobox", values:["Steady colors", "Every few seconds"], default:"Steady colors"},
	];
}

// The controller drives all of the card's visible lighting as one color.
const vLedNames = ["GPU"];
const vLedPositions = [[0, 0]];

const Address = 0x49;
const ConfigRegister = 0xA0;
const ActiveState = 0x01;
const IdleState = 0x00;
const ActiveSlot = 0x05;
const StaticMode = 0x00;

// Every config write makes the controller re-apply its lighting with a short
// blackout (verified 2026-11-07; OpenRGB's ZotacV2 driver has no direct mode
// either). So only push a color once it has held steady, and rarely.
const StableMs = 500;
const MinWriteIntervalMs = 2000;
const SteadyMaxStaleMs = 10000;   // "Steady colors": never sit on an old color longer
const PeriodicIntervalMs = 3000;  // "Every few seconds"

let lastKey = "";
let lastWrite = 0;
let pendingKey = "";
let pendingSince = 0;
let loggedFirstWrite = false;

/** 30-byte config packet (field names from OpenRGB's ZotacV2GPUController),
 *  byte-for-byte the static packet verified on the card, color varied. */
function BuildStaticPacket(rgb, idleActive) {
	const p = new Array(30).fill(0);
	p[0] = 0x01;          // on
	p[1] = 0x00;          // reset
	p[4] = idleActive;    // 1 = active-state config, 0 = idle-state config
	p[5] = ActiveSlot;    // zone
	p[6] = StaticMode;    // mode
	p[7] = rgb[0]; p[8] = rgb[1]; p[9] = rgb[2];   // color1
	p[10] = 0x2D;         // speed (unused by static)
	p[11] = 0x64;         // brightness 100
	p[12] = 0x01;         // direction
	p[14] = 0x01;         // syncMode
	p[15] = 0x00;         // circuit
	p[16] = 0x93; p[17] = 0x34; p[18] = 0xC2;   // color2 (unused by static)
	p[19] = 0x00;         // colorPreset
	return p;
}

const ZotacIDs = [
	{Vendor: 0x10DE, SubVendor: 0x19DA, Device: 0x2203, SubDevice: 0x4666, Name: "ZOTAC RTX 3090 Ti AMP Extreme Holo"},
];

function MatchId(bus) {
	for (const id of ZotacIDs) {
		if (id.Vendor === bus.Vendor() && id.SubVendor === bus.SubVendor() &&
			id.Device === bus.Product() && id.SubDevice === bus.SubDevice()) {
			return id;
		}
	}
	return null;
}

function hex2(n) { return "0x" + (n >>> 0).toString(16).padStart(2, "0"); }

/** @param {FreeAddressBus} bus */
export function Scan(bus) {
	if (!bus.IsNvidiaBus()) { return []; }

	bus.log(`ZOTAC SPECTRA: NVIDIA bus "${bus.Name()}" port ${bus.Port()} type ${bus.Type()} ids ` +
		`${hex2(bus.Vendor())}:${hex2(bus.Product())} sub ${hex2(bus.SubVendor())}:${hex2(bus.SubDevice())}`, {toFile: true});

	const id = MatchId(bus);
	if (!id) { return []; }

	// Diagnostic only: FireStorm's identify query. Expect "N666E-1017" back.
	try {
		const wr = bus.WriteBlockWithoutRegister(Address, 8, [0xA0, 0xF1, 0, 0, 0, 0, 0, 0]);
		const rd = bus.ReadBlockWithoutRegister(Address, 32);
		const bytes = (rd && rd[1]) ? Array.from(rd[1]) : [];
		const text = String.fromCharCode(...bytes.filter(b => b >= 0x20 && b < 0x7F));
		bus.log(`ZOTAC SPECTRA: identify on port ${bus.Port()}: write=${wr} read code=${rd ? rd[0] : "?"} ` +
			`text="${text}" bytes=[${bytes.map(hex2).join(" ")}]`, {toFile: true});
	} catch (e) {
		bus.log(`ZOTAC SPECTRA: identify threw: ${e}`, {toFile: true});
	}

	bus.log(`ZOTAC SPECTRA: matched ${id.Name} on "${bus.Name()}" port ${bus.Port()}, using ${hex2(Address)}`, {toFile: true});
	return [Address];
}

export function Initialize() {
	lastKey = "";
	lastWrite = 0;
	pendingKey = "";
	pendingSince = 0;
	loggedFirstWrite = false;
	const id = MatchId(bus);
	if (id) { device.setName(id.Name); }
	bus.log(`ZOTAC SPECTRA: initialized on "${bus.Name()}" port ${bus.Port()} addr ${hex2(bus.GetAddress())}`, {toFile: true});
}

export function Render() {
	const rgb = LightingMode === "Forced" ? hexToRgb(forcedColor) : device.color(0, 0);
	const key = rgb.join(",");
	const now = Date.now();
	if (key === lastKey) { pendingKey = ""; return; }

	let send = false;
	if (lastWrite === 0) {
		send = true;                                   // first color: immediately
	} else if (UpdateStyle === "Every few seconds") {
		send = now - lastWrite >= PeriodicIntervalMs;
	} else {
		if (key !== pendingKey) { pendingKey = key; pendingSince = now; }
		const stable = now - pendingSince >= StableMs && now - lastWrite >= MinWriteIntervalMs;
		const stale = now - lastWrite >= SteadyMaxStaleMs;
		send = stable || stale;
	}
	if (!send) { return; }

	SendColor(rgb);
	lastKey = key;
	pendingKey = "";
}

export function Shutdown(SystemSuspending) {
	SendColor(hexToRgb(SystemSuspending ? "#000000" : shutdownColor));
}

function SendColor(rgb) {
	// The controller picks the active or idle config by itself (idle when the
	// GPU idles), so both get the same color; otherwise the card goes dark or
	// stale when it switches.
	let ret = 0;
	for (const state of [ActiveState, IdleState]) {
		const packet = BuildStaticPacket(rgb, state);
		ret = bus.WriteBlock(ConfigRegister, packet.length, packet);
	}
	lastWrite = Date.now();
	if (!loggedFirstWrite) {
		bus.log(`ZOTAC SPECTRA: first write rgb=${rgb} ret=${ret}`, {toFile: true});
		loggedFirstWrite = true;
	}
}

function hexToRgb(hex) {
	const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	return [parseInt(r[1], 16), parseInt(r[2], 16), parseInt(r[3], 16)];
}
