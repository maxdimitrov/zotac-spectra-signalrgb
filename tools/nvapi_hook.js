// Frida agent: hook nvapi_QueryInterface in a 32-bit process, wrap every
// returned NvAPI function, log calls. I2C calls get full NV_I2C_INFO decode.
'use strict';

const KNOWN = {
  0x0150E828: 'Initialize',
  0xD22BDD7E: 'Unload',
  0xE5AC921F: 'EnumPhysicalGPUs',
  0x2FDE12C5: 'I2CRead',
  0xE812EB07: 'I2CWrite',
  0x4D7B0709: 'I2CReadEx',
  0x283AC65A: 'I2CWriteEx',
  0xCEEE8E9F: 'GPU_GetFullName',
  0x2DDFB66E: 'GPU_GetBusId',
  0x6E042794: 'GetErrorMessage',
};
const I2C = new Set([0x2FDE12C5, 0xE812EB07, 0x4D7B0709, 0x283AC65A]);
const FULL_LOG_CALLS = 20;

const t0 = Date.now();
function ts() { return ((Date.now() - t0) / 1000).toFixed(3).padStart(9); }
function hx(n) { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0'); }
function name(id) { return (KNOWN[id] || '?') + '[' + hx(id) + ']'; }
function bytes(p, n) {
  if (p.isNull() || n <= 0) return '';
  try {
    const a = new Uint8Array(p.readByteArray(Math.min(n, 64)));
    return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join(' ') + (n > 64 ? ' ...' : '');
  } catch (e) { return '<unreadable>'; }
}

function decodeI2C(p) {
  try {
    const ver = p.readU32();
    const size = ver & 0xffff;
    const o = {
      ver: ver >>> 16, size,
      displayMask: hx(p.add(4).readU32()),
      isDDC: p.add(8).readU8(),
      devAddr8: '0x' + p.add(9).readU8().toString(16),
      devAddr7: '0x' + (p.add(9).readU8() >> 1).toString(16),
      regSize: p.add(16).readU32(),
      cbSize: p.add(24).readU32(),
      speed: p.add(28).readU32(),
    };
    o.reg = bytes(p.add(12).readPointer(), o.regSize);
    o.dataPtr = p.add(20).readPointer();
    if (size >= 44) { o.speedKhz = p.add(32).readU32(); o.portId = p.add(36).readU8(); o.portSet = p.add(40).readU32(); }
    o.raw = bytes(p, size);
    return o;
  } catch (e) { return { err: String(e) }; }
}

const hooked = new Map();   // addr string -> id
const counts = {};

function hookFn(id, fp) {
  const key = fp.toString();
  if (hooked.has(key)) return;
  hooked.set(key, id);
  Interceptor.attach(fp, {
    onEnter(args) {
      this.id = id;
      counts[id] = (counts[id] || 0) + 1;
      this.n = counts[id];
      this.a = [args[0], args[1], args[2], args[3]];
      if (I2C.has(id)) {
        this.info = decodeI2C(args[1]);
        if (id === 0xE812EB07 || id === 0x283AC65A) {
          this.info.data = bytes(this.info.dataPtr, this.info.cbSize);
        }
      }
    },
    onLeave(ret) {
      const st = ret.toInt32();
      if (I2C.has(this.id)) {
        const i = this.info;
        if (this.id === 0x2FDE12C5 || this.id === 0x4D7B0709) i.data = bytes(i.dataPtr, i.cbSize);
        delete i.dataPtr;
        send(`${ts()} I2C ${name(this.id)} #${this.n} st=${st} gpu=${this.a[0]} ` + JSON.stringify(i));
      } else if (this.n <= FULL_LOG_CALLS) {
        send(`${ts()} CALL ${name(this.id)} #${this.n} st=${st} args=${this.a.join(',')} a1=[${bytes(this.a[1], 48)}] a2=[${bytes(this.a[2], 48)}]`);
      }
    },
  });
}

function hookModule(m) {
  const qi = m.findExportByName('nvapi_QueryInterface');
  if (!qi) { send(`# ${m.name} has no nvapi_QueryInterface`); return; }
  send(`# hooking ${m.name}!nvapi_QueryInterface at ${qi} (${m.path})`);
  Interceptor.attach(qi, {
    onEnter(args) { this.id = args[0].toUInt32(); },
    onLeave(ret) {
      send(`${ts()} QI ${name(this.id)} -> ${ret}`);
      if (!ret.isNull()) hookFn(this.id, ret);
    },
  });
}

let done = false;
function tryNow() {
  if (done) return;
  const m = Process.findModuleByName('nvapi.dll');
  if (m) { done = true; hookModule(m); }
}
Process.attachModuleObserver({
  onAdded(m) {
    if (m.name.toLowerCase() === 'nvapi.dll') tryNow();
  },
});
tryNow();

setInterval(() => {
  const s = Object.keys(counts).map(k => `${name(+k)}=${counts[k]}`).join(' ');
  send(`${ts()} COUNTS ${s}`);
}, 15000);
