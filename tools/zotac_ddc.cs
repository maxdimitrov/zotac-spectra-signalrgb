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
    static byte[] Query(byte[] cmd)
    {
        Check("command write", Xfer(true, null, cmd));
        Thread.Sleep(5);
        var buf = new byte[32];
        Check("reg 0xA0 read", Xfer(false, new byte[] { 0xA0 }, buf));
        return buf;
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
