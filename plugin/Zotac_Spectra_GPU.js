// ZOTAC SPECTRA 2.0 GPU lighting for SignalRGB.
// Protocol: docs/protocol.md in github.com/maxdimitrov/zotac-spectra-signalrgb
// (captured from ZOTAC FireStorm; NvAPI DDC port 1, address 0x49).
// Modifying SMBUS plugins is risky; this one only sends packets FireStorm itself sends.
export function Name() { return "ZOTAC SPECTRA 2.0 GPU"; }
export function Publisher() { return "maxdimitrov"; }
export function Type() { return "SMBUS"; }
export function Size() { return [28, 2]; }
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
		{property:"UpdateStyle", group:"lighting", label:"Update Style", description: "The card can blink briefly on a color update. 'Steady colors' updates when the effect colors hold still (and at least every 10 s); 'Every few seconds' follows any effect every 3 s", type:"combobox", values:["Steady colors", "Every few seconds"], default:"Steady colors"},
	];
}

// Four independently colored areas, each a single color: the controller has no
// per-LED write, so every LED in an area shows the same color. Zone ids and LED
// counts measured on the 3090 Ti AMP Extreme Holo 2026-11-07/08 (film of the
// built-in SLIDE effect, ~180 ms per LED step): side stripes 24, side logo 4,
// backplate stripes ~24, backplate claw logo 4. One canvas sample per LED; the
// area shows their average.
// Canvas: row 0 = backplate, row 1 = the side facing the window; x runs from the
// bracket end (0) to the far end (27), where both stripe areas sit.
const LogoXs = [0, 1, 2, 3];
const StripeXs = Array.from({length: 24}, (_, i) => 4 + i);
const Zones = [
	{name: "Side stripes",    id: 0x00, y: 1, xs: StripeXs},
	{name: "Side ZOTAC logo", id: 0x01, y: 1, xs: LogoXs},
	{name: "Backplate stripes", id: 0x02, y: 0, xs: StripeXs},
	{name: "Backplate logo",  id: 0x03, y: 0, xs: LogoXs},
];
const vLedNames = [];
const vLedPositions = [];
for (const z of Zones) {
	z.xs.forEach((x, i) => { vLedNames.push(`${z.name} ${i + 1}`); vLedPositions.push([x, z.y]); });
}

const Address = 0x49;
const ConfigRegister = 0xA0;
const ActiveState = 0x01;
const IdleState = 0x00;
const StaticMode = 0x00;
const SyncOff = 0x00;   // per-zone colors (0x01 = all zones follow zone 5)

// Every config write can make the controller re-apply its lighting with a
// ~40 ms blackout (2-6% of updates, at any rate, measured 2026-11-07; there is
// no direct mode). So only push colors once they have held steady, and rarely.
const StableMs = 500;
const MinWriteIntervalMs = 2000;
const SteadyMaxStaleMs = 10000;   // "Steady colors": never sit on old colors longer
const PeriodicIntervalMs = 3000;  // "Every few seconds"

let lastKeys = [];
let lastWrite = 0;
let pendingKey = "";
let pendingSince = 0;
let loggedFirstWrite = false;

/** 30-byte config packet (field names from OpenRGB's ZotacV2GPUController),
 *  the static packet verified on the card, per zone and idle/active state. */
function BuildStaticPacket(rgb, zone, idleActive) {
	const p = new Array(30).fill(0);
	p[0] = 0x01;          // on
	p[1] = 0x00;          // reset
	p[4] = idleActive;    // 1 = active-state config, 0 = idle-state config
	p[5] = zone;          // 0-3 card areas, 5 = all synchronized
	p[6] = StaticMode;    // mode
	p[7] = rgb[0]; p[8] = rgb[1]; p[9] = rgb[2];   // color1
	p[10] = 0x2D;         // speed (unused by static)
	p[11] = 0x64;         // brightness 100
	p[12] = 0x01;         // direction
	p[14] = SyncOff;      // syncMode
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
	lastKeys = [];
	lastWrite = 0;
	pendingKey = "";
	pendingSince = 0;
	loggedFirstWrite = false;
	const id = MatchId(bus);
	if (id) { device.setName(id.Name); }
	bus.log(`ZOTAC SPECTRA: initialized on "${bus.Name()}" port ${bus.Port()} addr ${hex2(bus.GetAddress())}`, {toFile: true});
}

function CurrentColors() {
	if (LightingMode === "Forced") {
		const c = hexToRgb(forcedColor);
		return Zones.map(() => c);
	}
	return Zones.map(z => {
		const sum = [0, 0, 0];
		for (const x of z.xs) {
			const c = device.color(x, z.y);
			sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
		}
		return sum.map(v => Math.round(v / z.xs.length));
	});
}

export function Render() {
	const colors = CurrentColors();
	const keys = colors.map(c => c.join(","));
	const key = keys.join("|");
	const now = Date.now();
	if (key === lastKeys.join("|")) { pendingKey = ""; return; }

	let send = false;
	if (lastWrite === 0) {
		send = true;                                   // first colors: immediately
	} else if (UpdateStyle === "Every few seconds") {
		send = now - lastWrite >= PeriodicIntervalMs;
	} else {
		if (key !== pendingKey) { pendingKey = key; pendingSince = now; }
		const stable = now - pendingSince >= StableMs && now - lastWrite >= MinWriteIntervalMs;
		const stale = now - lastWrite >= SteadyMaxStaleMs;
		send = stable || stale;
	}
	if (!send) { return; }

	SendColors(colors, keys, false);
	lastKeys = keys;
	pendingKey = "";
}

export function Shutdown(SystemSuspending) {
	const c = hexToRgb(SystemSuspending ? "#000000" : shutdownColor);
	SendColors(Zones.map(() => c), [], true);
}

/** Writes each zone whose color changed (or all when forced). The controller
 *  picks the active or idle config by itself (idle when the GPU idles), so
 *  both get the same color; otherwise the card goes dark or stale when it
 *  switches. */
function SendColors(colors, keys, all) {
	let ret = 0;
	Zones.forEach((zone, i) => {
		if (!all && lastKeys[i] === keys[i]) { return; }
		for (const state of [ActiveState, IdleState]) {
			const packet = BuildStaticPacket(colors[i], zone.id, state);
			ret = bus.WriteBlock(ConfigRegister, packet.length, packet);
		}
	});
	lastWrite = Date.now();
	if (!loggedFirstWrite) {
		bus.log(`ZOTAC SPECTRA: first write colors=${colors.map(c => c.join(",")).join(" | ")} ret=${ret}`, {toFile: true});
		loggedFirstWrite = true;
	}
}

function hexToRgb(hex) {
	const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	return [parseInt(r[1], 16), parseInt(r[2], 16), parseInt(r[3], 16)];
}
