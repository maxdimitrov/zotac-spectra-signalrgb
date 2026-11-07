// zotac_ddc.cs
//
// Talks to the ZOTAC SPECTRA 2.0 RGB controller on the RTX 3090 Ti AMP
// Extreme Holo exactly the way ZOTAC FireStorm does (captured with Frida,
// see captures/2026-11-06-firestorm-trace.log):
//   public NvAPI_I2CWrite / NvAPI_I2CRead, NV_I2C_INFO_V3,
//   bIsDDCPort=1, portId=1 (set), displayMask=1, 100 kHz, 7-bit addr 0x49.
//
// Commands:
//   zotac_ddc id                 read controller id string (expect N666E-1017)
//   zotac_ddc dump               read stored config for zones 0-1, slots 0-6
//   zotac_ddc write <30 hex>     write a 30-byte config packet to reg 0xA0
//
// Never writes reg 0xA2 (FireStorm writes 0x01 there; looks like save-to-flash).
//
// Build: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /platform:x64 /out:zotac_ddc.exe zotac_ddc.cs

using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

class ZotacDdc
{
    [DllImport("nvapi64.dll", EntryPoint = "nvapi_QueryInterface", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr QueryInterface(uint id);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Init_t();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Unload_t();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int EnumGPUs_t([In, Out] IntPtr[] h, out int n);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int I2C_t(IntPtr gpu, IntPtr info);

    [StructLayout(LayoutKind.Sequential)]
    struct NV_I2C_INFO_V3
    {
        public uint version;
        public uint displayMask;
        public byte bIsDDCPort;
        public byte i2cDevAddress;
        public IntPtr pbI2cRegAddress;
        public uint regAddrSize;
        public IntPtr pbData;
        public uint cbSize;
        public uint i2cSpeed;
        public uint i2cSpeedKhz;
        public byte portId;
        public uint bIsPortIdSet;
    }

    const byte ADDR = 0x49;
    const byte PORT = 1;
    const uint DISPLAY_MASK = 1;

    static I2C_t i2cRead, i2cWrite;
    static IntPtr gpu;
    static uint infoVersion;

    static T Fn<T>(uint id) where T : class
    {
        IntPtr p = QueryInterface(id);
        return p == IntPtr.Zero ? null : Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T;
    }

    // reg == null -> no register phase (raw transfer), as FireStorm does for commands.
    static int Xfer(bool write, byte[] reg, byte[] data)
    {
        byte[] r = reg ?? new byte[1];
        GCHandle hr = GCHandle.Alloc(r, GCHandleType.Pinned);
        GCHandle hd = GCHandle.Alloc(data, GCHandleType.Pinned);
        IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NV_I2C_INFO_V3)));
        try
        {
            var info = new NV_I2C_INFO_V3
            {
                version = infoVersion,
                displayMask = DISPLAY_MASK,
                bIsDDCPort = 1,
                i2cDevAddress = (byte)(ADDR << 1),
                pbI2cRegAddress = reg == null ? IntPtr.Zero : hr.AddrOfPinnedObject(),
                regAddrSize = reg == null ? 0u : (uint)reg.Length,
                pbData = hd.AddrOfPinnedObject(),
                cbSize = (uint)data.Length,
                i2cSpeed = 0xFFFF,
                i2cSpeedKhz = 4,
                portId = PORT,
                bIsPortIdSet = 1,
            };
            Marshal.StructureToPtr(info, p, false);
            return write ? i2cWrite(gpu, p) : i2cRead(gpu, p);
        }
        finally { Marshal.FreeHGlobal(p); hr.Free(); hd.Free(); }
    }

    static string Hex(byte[] d)
    {
        var sb = new StringBuilder();
        foreach (byte b in d) sb.Append(b.ToString("x2")).Append(' ');
        return sb.ToString().TrimEnd();
    }

    static byte[] ParseHex(string s)
    {
        s = s.Replace(" ", "").Replace("-", "").Replace(",", "");
        if (s.Length % 2 != 0) throw new ArgumentException("odd hex length");
        var b = new byte[s.Length / 2];
        for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(s.Substring(i * 2, 2), 16);
        return b;
    }

    static void Check(string what, int st)
    {
        if (st != 0) throw new Exception(what + " failed, NvAPI status " + st);
    }

    // Command (raw 8 bytes) then read 32 bytes from reg 0xA0.
    // Retries because another writer (SignalRGB) may hit the bus between the
    // command and the read.
    static byte[] Query(byte[] cmd)
    {
        for (int attempt = 1; ; attempt++)
        {
            var buf = new byte[32];
            int st = Xfer(true, null, cmd);
            if (st == 0) { Thread.Sleep(5); st = Xfer(false, new byte[] { 0xA0 }, buf); }
            if (st == 0 && buf[4] == cmd[5] && buf[5] == cmd[6]) return buf;
            if (attempt >= 20) throw new Exception("query failed after 20 attempts, last NvAPI status " + st);
            Thread.Sleep(3);
        }
    }

    // Same packets as the SignalRGB plugin: static, verified bytes, written to
    // both the active (idleActive=1) and idle (idleActive=0) configs. The
    // controller switches between them by itself (GPU idle -> idle config), so
    // writing only one leaves the card on a stale or dark config.
    static void Static(byte[] rgb, byte syncMode = 0x01)
    {
        foreach (byte idleActive in new byte[] { 0x01, 0x00 })
        {
            var p = new byte[30];
            p[0] = 0x01; p[4] = idleActive; p[5] = 0x05; p[6] = 0x00;
            p[7] = rgb[0]; p[8] = rgb[1]; p[9] = rgb[2];
            p[10] = 0x2D; p[11] = 0x64; p[12] = 0x01; p[14] = syncMode;
            p[16] = 0x93; p[17] = 0x34; p[18] = 0xC2;
            Check("reg 0xA0 write", Xfer(true, new byte[] { 0xA0 }, p));
        }
    }

    static int[] ParseInts(string[] a, int from)
    {
        var r = new int[a.Length - from];
        for (int i = from; i < a.Length; i++) r[i - from] = int.Parse(a[i]);
        return r;
    }

    static byte[] Hue(double h)
    {
        double x = 1 - Math.Abs((h / 60) % 2 - 1);
        double r = 0, g = 0, b = 0;
        if (h < 60) { r = 1; g = x; } else if (h < 120) { r = x; g = 1; } else if (h < 180) { g = 1; b = x; }
        else if (h < 240) { g = x; b = 1; } else if (h < 300) { r = x; b = 1; } else { r = 1; b = x; }
        return new byte[] { (byte)(r * 255), (byte)(g * 255), (byte)(b * 255) };
    }

    static int Main(string[] args)
    {
        if (args.Length < 1) { Console.WriteLine("usage: zotac_ddc id | dump | write <30 hex bytes>"); return 2; }

        var init = Fn<Init_t>(0x0150E828);
        var unload = Fn<Unload_t>(0xD22BDD7E);
        var enumGpus = Fn<EnumGPUs_t>(0xE5AC921F);
        i2cRead = Fn<I2C_t>(0x2FDE12C5);
        i2cWrite = Fn<I2C_t>(0xE812EB07);
        if (init == null || enumGpus == null || i2cRead == null || i2cWrite == null)
        { Console.WriteLine("ERROR: NvAPI function resolution failed"); return 1; }

        try
        {
            Check("NvAPI_Initialize", init());
            var gpus = new IntPtr[64]; int n;
            Check("EnumPhysicalGPUs", enumGpus(gpus, out n));
            if (n < 1) throw new Exception("no NVIDIA GPU");
            gpu = gpus[0];
            infoVersion = (uint)Marshal.SizeOf(typeof(NV_I2C_INFO_V3)) | (3u << 16);

            switch (args[0])
            {
                case "id":
                {
                    var b = Query(new byte[] { 0xA0, 0xF1, 0, 0, 0, 0, 0, 0 });
                    int len = Array.IndexOf(b, (byte)0); if (len < 0) len = b.Length;
                    Console.WriteLine("id: \"" + Encoding.ASCII.GetString(b, 0, len) + "\"  raw: " + Hex(b));
                    break;
                }
                case "dump":
                    for (byte z = 0; z < 2; z++)
                        for (byte s = 0; s < 7; s++)
                            Console.WriteLine("zone " + z + " slot " + s + ": "
                                + Hex(Query(new byte[] { 0xA0, 0xF0, 0, 0, 0, z, s, 0 })));
                    break;
                case "get":
                {
                    byte z = byte.Parse(args[1]), s = byte.Parse(args[2]);
                    Console.WriteLine("zone " + z + " slot " + s + ": "
                        + Hex(Query(new byte[] { 0xA0, 0xF0, 0, 0, 0, z, s, 0 })));
                    break;
                }
                case "blinktest":
                {
                    // Phase 1 (3 s): one red write.
                    // Phase 2 (5 s): identical green packet re-sent 10x/s.
                    // Phase 3 (5 s): rainbow, 10 writes/s.
                    // Phase 4 (5 s): rainbow, 30 writes/s.
                    // End: static blue.
                    Console.WriteLine("phase 1: red once"); Static(new byte[] { 255, 0, 0 }); Thread.Sleep(3000);
                    Console.WriteLine("phase 2: same green x10/s");
                    for (int i = 0; i < 50; i++) { Static(new byte[] { 0, 255, 0 }); Thread.Sleep(100); }
                    Console.WriteLine("phase 3: rainbow x10/s");
                    for (int i = 0; i < 50; i++) { Static(Hue(i * 360.0 / 50)); Thread.Sleep(100); }
                    Console.WriteLine("phase 4: rainbow x30/s");
                    for (int i = 0; i < 150; i++) { Static(Hue(i * 360.0 / 150)); Thread.Sleep(33); }
                    Console.WriteLine("end: blue"); Static(new byte[] { 0, 0, 255 });
                    break;
                }
                case "ratetest":
                {
                    // ratetest [secondsPerPhase] [intervalMs...]
                    // Rainbow at shrinking update intervals. Default 5 s at 1000/500/250/100 ms.
                    // The hue keeps advancing so every write is a new color.
                    int phaseSec = args.Length > 1 ? int.Parse(args[1]) : 5;
                    int[] intervals = args.Length > 2 ? ParseInts(args, 2) : new[] { 1000, 500, 250, 100 };
                    double hue = 0;
                    foreach (int ms in intervals)
                    {
                        Console.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + " every " + ms + " ms");
                        var end = DateTime.Now.AddSeconds(phaseSec);
                        while (DateTime.Now < end)
                        {
                            Static(Hue(hue)); hue = (hue + 37) % 360;
                            Thread.Sleep(ms);
                        }
                    }
                    Console.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + " end: blue"); Static(new byte[] { 0, 0, 255 });
                    break;
                }
                case "abtest":
                {
                    // abtest [writesPerRun] [intervalMs]
                    // 5 s lead-in on blue, then three runs separated by 5 s holds:
                    //   A rainbow, syncMode 1 (baseline)
                    //   B same green re-sent, syncMode 1
                    //   C rainbow, syncMode 0
                    // Every write is logged with a timestamp for video alignment.
                    int writes = args.Length > 1 ? int.Parse(args[1]) : 120;
                    int ms = args.Length > 2 ? int.Parse(args[2]) : 500;
                    Func<string> ts = () => DateTime.Now.ToString("HH:mm:ss.fff");
                    Static(new byte[] { 0, 0, 255 });
                    Console.WriteLine(ts() + " lead-in blue"); Thread.Sleep(5000);
                    string[] names = { "A rainbow sync1", "B same-green sync1", "C rainbow sync0" };
                    for (int run = 0; run < 3; run++)
                    {
                        Console.WriteLine(ts() + " run " + names[run]);
                        double hue = 0;
                        for (int i = 0; i < writes; i++)
                        {
                            byte[] rgb = run == 1 ? new byte[] { 0, 255, 0 } : Hue(hue);
                            Static(rgb, run == 2 ? (byte)0 : (byte)1);
                            Console.WriteLine(ts() + " w " + run + " " + i);
                            hue = (hue + 37) % 360;
                            Thread.Sleep(ms);
                        }
                        Static(new byte[] { 0, 0, 255 });
                        Console.WriteLine(ts() + " hold blue"); Thread.Sleep(5000);
                    }
                    Console.WriteLine(ts() + " end");
                    break;
                }
                case "write":
                {
                    var pkt = ParseHex(string.Join("", args, 1, args.Length - 1));
                    if (pkt.Length != 30) throw new Exception("packet must be 30 bytes, got " + pkt.Length);
                    Check("reg 0xA0 write", Xfer(true, new byte[] { 0xA0 }, pkt));
                    Console.WriteLine("wrote: " + Hex(pkt));
                    break;
                }
                default:
                    Console.WriteLine("unknown command " + args[0]); return 2;
            }
            return 0;
        }
        catch (Exception e) { Console.WriteLine("ERROR: " + e.Message); return 1; }
        finally { if (unload != null) unload(); }
    }
}
