// ZOTAC SPECTRA 2.0 GPU lighting for SignalRGB.
// Protocol: docs/protocol.md in github.com/maxdimitrov/zotac-spectra-signalrgb
// (captured from ZOTAC FireStorm; NvAPI DDC port 1, address 0x49).
// Modifying SMBUS Plugins is -DANGEROUS- and can -DESTROY- devices.
// This one only sends packet layouts ZOTAC FireStorm itself sends, and never
// writes register 0xA2 (FireStorm's save-to-flash).
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
ColorUpdates:readonly
HardwareEffect:readonly
EffectSpeed:readonly
DirSideStripes:readonly
DirSideLogo:readonly
DirBackStripes:readonly
DirBackLogo:readonly
*/
export function ControllableParameters() {
	return [
		{property:"shutdownColor", group:"lighting", label:"Shutdown Color", description: "Applied when the system or SignalRGB shuts down", min:"0", max:"360", type:"color", default:"#000000"},
		{property:"LightingMode", group:"lighting", label:"Lighting Mode", description: "Canvas follows the active effect, Forced uses a fixed color", type:"combobox", values:["Canvas", "Forced"], default:"Canvas"},
		{property:"forcedColor", group:"lighting", label:"Forced Color", description: "Color used when Lighting Mode is Forced", min:"0", max:"360", type:"color", default:"#009bde"},
		{property:"ColorUpdates", group:"lighting", label:"Color Updates", description: "How often canvas color changes are sent to the card. The controller stores every update in its flash memory, which wears out, so updates are rare and only sent once a color holds still; use a Card Effect for motion. 'Only on setting changes' never follows the canvas", type:"combobox", values:["Every minute", "Every 5 minutes", "Only on setting changes"], default:"Every minute"},
		{property:"HardwareEffect", group:"lighting", label:"Card Effect", description: "Animation the card runs by itself, so it moves smoothly with no updates (and no blinks). Static, Slide, Breathing, Marquee and Drip use each area's canvas color; Duet chases the two colors at the two ends of each area; Rainbow and Path use the card's own colors and turn off while the canvas is black (idle, lights off)", type:"combobox", values:["Static", "Slide", "Breathing", "Marquee", "Drip", "Duet", "Rainbow", "Path"], default:"Static"},
		{property:"EffectSpeed", group:"lighting", label:"Card Effect Speed", description: "Speed of the card's own animation (higher = faster)", step:"1", type:"number", min:"1", max:"100", default:"20"},
		{property:"DirSideStripes", group:"lighting", label:"Direction: Side stripes", description: "Which way moving effects flow in this area (Static and Breathing have no direction)", type:"combobox", values:["Forward", "Reverse"], default:"Forward"},
		{property:"DirSideLogo", group:"lighting", label:"Direction: Side ZOTAC logo", description: "Which way moving effects flow in this area (Static and Breathing have no direction)", type:"combobox", values:["Forward", "Reverse"], default:"Forward"},
		{property:"DirBackStripes", group:"lighting", label:"Direction: Backplate stripes", description: "Which way moving effects flow in this area (Static and Breathing have no direction)", type:"combobox", values:["Forward", "Reverse"], default:"Forward"},
		{property:"DirBackLogo", group:"lighting", label:"Direction: Backplate logo", description: "Which way moving effects flow in this area (Static and Breathing have no direction)", type:"combobox", values:["Forward", "Reverse"], default:"Forward"},
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
	{name: "Side stripes",    id: 0x00, y: 1, xs: StripeXs, dir: () => DirSideStripes},
	{name: "Side ZOTAC logo", id: 0x01, y: 1, xs: LogoXs, dir: () => DirSideLogo},
	{name: "Backplate stripes", id: 0x02, y: 0, xs: StripeXs, dir: () => DirBackStripes},
	{name: "Backplate logo",  id: 0x03, y: 0, xs: LogoXs, dir: () => DirBackLogo},
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
// Card-side animation modes (OpenRGB ZotacV2GPUController names).
const EffectModes = {
	"Static": 0x00, "Breathing": 0x01, "Slide": 0x07, "Rainbow": 0x08,
	"Marquee": 0x09, "Drip": 0x0A, "Duet": 0x17, "Path": 0x18,
};
// Effects that draw their own colors and ignore color1/color2.
const OwnColorEffects = ["Rainbow", "Path"];
const DuetCustomPreset = 0x04;   // colorPreset index after OpenRGB's 4 built-in duet pairs
const SyncOff = 0x00;   // per-zone colors (0x01 = all zones follow zone 5)

// Every config write is most likely stored in the controller's flash: stored
// configs survive power loss, OpenRGB marks every mode "automatic save", and
// SignalRGB declined Zotac support over flash wear. Each write can also black
// the card out for ~40 ms (2-6% of writes, measured 2026-11-07). So write as
// little as possible: card effects do the motion; canvas colors go out at most
// once per Color Updates interval, once they have held for StableMs, and only
// when the change is visible.
const StableMs = 1000;
const UpdateIntervals = {"Every minute": 60000, "Every 5 minutes": 300000, "Only on setting changes": Infinity};
const MinVisibleDiff = 24;        // largest channel difference that still counts as "same color"
const WriteLogEvery = 100;        // log the running config-write count every N writes
// Rainbow and Path ignore the canvas, so they would stay lit when SignalRGB
// blacks the canvas (idle timeout, lights off). An all-black canvas held this
// long turns the card off instead; any color brings the effect back.
const DarkHoldMs = 2000;

let lastColors = [];      // per zone, as last written
let lastWrite = 0;
let pending = null;       // colors waiting to hold still
let pendingSince = 0;
let writeCount = 0;       // config packets written since Initialize
let loggedFirstWrite = false;
let lastEffectKey = "";
let darkSince = 0;

/** 30-byte config packet (field names from OpenRGB's ZotacV2GPUController),
 *  the static packet verified on the card, per zone and idle/active state,
 *  with the card-side animation mode and speed. */
function BuildPacket(rgb, zone, idleActive, mode, speed, direction) {
	const duet = rgb.length >= 6;
	const p = new Array(30).fill(0);
	p[0] = 0x01;          // on
	p[1] = 0x00;          // reset
	p[4] = idleActive;    // 1 = active-state config, 0 = idle-state config
	p[5] = zone;          // 0-3 card areas, 5 = all synchronized
	p[6] = mode;          // mode
	p[7] = rgb[0]; p[8] = rgb[1]; p[9] = rgb[2];   // color1
	p[10] = speed;        // speed 0x00-0x64 (unused by static)
	p[11] = 0x64;         // brightness 100
	p[12] = direction;    // 1 = OpenRGB "right" (Forward), 0 = "left" (Reverse)
	p[14] = SyncOff;      // syncMode
	p[15] = 0x00;         // circuit
	if (duet) {           // color2 + "custom" preset, as OpenRGB sends for Duet
		p[16] = rgb[3]; p[17] = rgb[4]; p[18] = rgb[5];
		p[19] = DuetCustomPreset;
	} else {              // FireStorm's defaults (color2 unused by one-color modes)
		p[16] = 0x93; p[17] = 0x34; p[18] = 0xC2;
		p[19] = 0x00;
	}
	return p;
}

const ZotacIDs = [
	{Vendor: 0x10DE, SubVendor: 0x19DA, Device: 0x2203, SubDevice: 0x4666, Controller: "N666E-1017", Name: "ZOTAC RTX 3090 Ti AMP Extreme Holo"},
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

/** FireStorm's identify query: raw `a0 f1 00..`, then 32 bytes from reg 0xA0
 *  hold the controller id as ASCII. Retried because the bus can be busy. */
function ReadControllerId(bus) {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			bus.WriteBlockWithoutRegister(Address, 8, [0xA0, 0xF1, 0, 0, 0, 0, 0, 0]);
			const rd = bus.ReadBlockWithoutRegister(Address, 32);
			const bytes = (rd && rd[0] === 0 && rd[1]) ? Array.from(rd[1]) : [];
			const text = String.fromCharCode(...bytes.filter(b => b >= 0x20 && b < 0x7F));
			if (text.length > 0) { return text; }
		} catch (e) {
			bus.log(`ZOTAC SPECTRA: identify threw: ${e}`, {toFile: true});
		}
	}
	return "";
}

/** @param {FreeAddressBus} bus */
export function Scan(bus) {
	if (!bus.IsNvidiaBus()) { return []; }

	const id = MatchId(bus);
	if (!id) { return []; }

	// Only claim the card when the controller answers with the expected id, so
	// a board revision with another controller is never written to.
	const controller = ReadControllerId(bus);
	if (!controller.includes(id.Controller)) {
		bus.log(`ZOTAC SPECTRA: ${id.Name} on port ${bus.Port()} answered "${controller}", ` +
			`expected "${id.Controller}"; not claiming it`, {toFile: true});
		return [];
	}

	bus.log(`ZOTAC SPECTRA: found ${id.Name} (controller ${controller}) on port ${bus.Port()}`, {toFile: true});
	return [Address];
}

export function Initialize() {
	lastColors = [];
	lastEffectKey = "";
	darkSince = 0;
	lastWrite = 0;
	pending = null;
	pendingSince = 0;
	writeCount = 0;
	loggedFirstWrite = false;
	const id = MatchId(bus);
	if (id) { device.setName(id.Name); }
	bus.log(`ZOTAC SPECTRA: initialized on "${bus.Name()}" port ${bus.Port()} addr ${hex2(bus.GetAddress())}`, {toFile: true});
}

function Average(z, xs) {
	const sum = [0, 0, 0];
	for (const x of xs) {
		const c = device.color(x, z.y);
		sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
	}
	return sum.map(v => Math.round(v / xs.length));
}

/** Duet's second color: when both ends of an area show (nearly) the same
 *  color, chase it with a dim copy of itself so the motion stays visible. */
function DuetPair(c1, c2) {
	const diff = Math.abs(c1[0] - c2[0]) + Math.abs(c1[1] - c2[1]) + Math.abs(c1[2] - c2[2]);
	return diff < 48 ? [...c1, ...c1.map(v => Math.round(v / 4))] : [...c1, ...c2];
}

/** One color per area ([r,g,b]); for Duet two ([r,g,b,r2,g2,b2]): the
 *  averages of the area's two halves. */
function CurrentColors(duet) {
	if (LightingMode === "Forced") {
		const c = hexToRgb(forcedColor);
		return Zones.map(() => duet ? DuetPair(c, c) : c);
	}
	return Zones.map(z => {
		if (!duet) { return Average(z, z.xs); }
		const half = z.xs.length / 2;
		return DuetPair(Average(z, z.xs.slice(0, half)), Average(z, z.xs.slice(half)));
	});
}

export function Render() {
	const now = Date.now();
	const canvas = CurrentColors(HardwareEffect === "Duet");
	const allBlack = canvas.every(c => c.every(v => v === 0));
	if (!allBlack) {
		darkSince = 0;
	} else if (darkSince === 0) {
		darkSince = now;
	}
	const dark = allBlack && now - darkSince >= DarkHoldMs;
	const ownColors = OwnColorEffects.includes(HardwareEffect);
	const effect = (ownColors && dark) ? "Static" : HardwareEffect;
	const colors = OwnColorEffects.includes(effect) ? Zones.map(() => [255, 255, 255]) : canvas;
	const effectKey = `${effect}/${Math.round(EffectSpeed)}/${Zones.map(z => z.dir()).join(",")}`;

	if (effectKey !== lastEffectKey) {                // setting changed or Rainbow/Path on/off: rewrite everything now
		if (ownColors && lastEffectKey !== "") {
			bus.log(`ZOTAC SPECTRA: canvas ${dark ? "dark, card off" : `lit, ${HardwareEffect} on`}`, {toFile: true});
		}
		SendColors(colors, true, effect);
		lastEffectKey = effectKey;
		pending = null;
		return;
	}
	if (!colors.some((c, i) => Differs(c, lastColors[i]))) { pending = null; return; }

	if (pending === null || colors.some((c, i) => Differs(c, pending[i]))) {
		pending = colors;
		pendingSince = now;
	}
	const interval = (ColorUpdates in UpdateIntervals) ? UpdateIntervals[ColorUpdates] : 60000;
	const due = now - lastWrite >= interval;
	const stable = now - pendingSince >= StableMs;
	const stale = now - lastWrite >= 2 * interval;    // a canvas that never holds still
	if (!(due && (stable || stale))) { return; }

	SendColors(colors, false, effect);
	pending = null;
}

/** A visible change: any channel moved more than MinVisibleDiff, or the area
 *  goes fully black (so "off" is never left dimly lit). */
function Differs(a, b) {
	if (!b || a.length !== b.length) { return true; }
	if (a.every(v => v === 0)) { return b.some(v => v !== 0); }
	return a.some((v, i) => Math.abs(v - b[i]) > MinVisibleDiff);
}

export function Shutdown(SystemSuspending) {
	const c = hexToRgb(SystemSuspending ? "#000000" : shutdownColor);
	SendColors(Zones.map(() => c), true, "Static");
	bus.log(`ZOTAC SPECTRA: shutdown after ${writeCount} config writes`, {toFile: true});
}

/** Writes each zone whose color visibly changed (or all when forced). The controller
 *  picks the active or idle config by itself (idle when the GPU idles), so
 *  both get the same color; otherwise the card goes dark or stale when it
 *  switches. */
function SendColors(colors, all, effect = HardwareEffect) {
	const mode = (effect in EffectModes) ? EffectModes[effect] : 0x00;
	const speed = Math.max(0, Math.min(100, Math.round(EffectSpeed)));
	let ret = 0;
	Zones.forEach((zone, i) => {
		if (!all && !Differs(colors[i], lastColors[i])) { return; }
		const direction = zone.dir() === "Reverse" ? 0x00 : 0x01;
		for (const state of [ActiveState, IdleState]) {
			const packet = BuildPacket(colors[i], zone.id, state, mode, speed, direction);
			ret = bus.WriteBlock(ConfigRegister, packet.length, packet);
			writeCount++;
			if (writeCount % WriteLogEvery === 0) {
				bus.log(`ZOTAC SPECTRA: ${writeCount} config writes since start`, {toFile: true});
			}
		}
		lastColors[i] = colors[i];
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
