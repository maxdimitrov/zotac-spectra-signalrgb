// nvapi_i2c_sweep.cs
//
// Diagnostic tool for the zotac-spectra-signalrgb project (Phase 0 discovery).
//
// OpenRGB's SMBus Tools only probe one I2C port on the GPU. NVIDIA GPUs expose
// several I2C ports through NvAPI. This tool sweeps every port (and address)
// via NvAPI_I2CRead to locate the SPECTRA RGB controller.
//
// Read-only: it only performs 1-byte register reads. No writes.
//
// Build (no IDE needed):
//   csc.exe /out:nvapi_i2c_sweep.exe nvapi_i2c_sweep.cs
// Run:
//   nvapi_i2c_sweep.exe

using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

class NvApiI2cSweep
{
    // nvapi64.dll exposes a single real export; every other function is
    // obtained by querying a numeric interface id.
    [DllImport("nvapi64.dll", EntryPoint = "nvapi_QueryInterface", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr NvAPI_QueryInterface(uint id);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int Init_t();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int Unload_t();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int EnumGPUs_t([In, Out] IntPtr[] handles, out int count);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    delegate int I2CRead_t(IntPtr gpu, IntPtr info);

    // NV_I2C_INFO version 3 - the first version with portId / bIsPortIdSet.
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

    static I2CRead_t i2cRead;
    static uint infoVersion;

    static T Fn<T>(uint id) where T : class
    {
        IntPtr p = NvAPI_QueryInterface(id);
        if (p == IntPtr.Zero) return null;
        return Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T;
    }

    static int Read(IntPtr gpu, int port, bool ddc, int addr, int count, out byte[] data)
    {
        data = new byte[count];
        byte[] reg = new byte[1] { 0x00 };
        GCHandle hReg = GCHandle.Alloc(reg, GCHandleType.Pinned);
        GCHandle hData = GCHandle.Alloc(data, GCHandleType.Pinned);
        IntPtr pInfo = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NV_I2C_INFO_V3)));
        try
        {
            NV_I2C_INFO_V3 info = new NV_I2C_INFO_V3();
            info.version = infoVersion;
            info.displayMask = 0;
            info.bIsDDCPort = (byte)(ddc ? 1 : 0);
            info.i2cDevAddress = (byte)(addr << 1);
            info.pbI2cRegAddress = hReg.AddrOfPinnedObject();
            info.regAddrSize = 1;
            info.pbData = hData.AddrOfPinnedObject();
            info.cbSize = (uint)count;
            info.i2cSpeed = 0xFFFF;   // deprecated field; tells NvAPI to use i2cSpeedKhz
            info.i2cSpeedKhz = 4;     // NVAPI_I2C_SPEED_100KHZ
            info.portId = (byte)port;
            info.bIsPortIdSet = 1;
            Marshal.StructureToPtr(info, pInfo, false);
            return i2cRead(gpu, pInfo);
        }
        catch (Exception e)
        {
            Console.WriteLine("  exception: " + e.Message);
            return -9999;
        }
        finally
        {
            Marshal.FreeHGlobal(pInfo);
            hReg.Free();
            hData.Free();
        }
    }

    static string Hex(byte[] d)
    {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < d.Length; i++) sb.Append(d[i].ToString("X2") + " ");
        return sb.ToString().Trim();
    }

    static void Main()
    {
        var init = Fn<Init_t>(0x0150E828);
        var unload = Fn<Unload_t>(0xD22BDD7E);
        var enumGpus = Fn<EnumGPUs_t>(0xE5AC921F);
        i2cRead = Fn<I2CRead_t>(0x2FDE12C5);

        Console.WriteLine("resolved: init=" + (init != null) + " enum=" + (enumGpus != null)
            + " i2cRead=" + (i2cRead != null) + " unload=" + (unload != null));
        if (init == null || enumGpus == null || i2cRead == null)
        {
            Console.WriteLine("ERROR: NvAPI function resolution failed");
            return;
        }

        int st = init();
        Console.WriteLine("NvAPI_Initialize status=" + st);
        if (st != 0) return;

        IntPtr[] gpus = new IntPtr[64];
        int count;
        st = enumGpus(gpus, out count);
        Console.WriteLine("EnumPhysicalGPUs status=" + st + " count=" + count);
        if (st != 0 || count < 1) { if (unload != null) unload(); return; }

        int sz = Marshal.SizeOf(typeof(NV_I2C_INFO_V3));
        infoVersion = (uint)sz | (3u << 16);
        Console.WriteLine("NV_I2C_INFO_V3 size=" + sz + " version=0x" + infoVersion.ToString("X8"));
        Console.WriteLine("sweeping ports 0-15, addresses 0x08-0x77, non-DDC and DDC...");

        var statusHist = new Dictionary<int, int>();
        int responders = 0;

        for (int g = 0; g < count; g++)
        {
            Console.WriteLine("=== GPU " + g + " ===");
            foreach (bool ddc in new bool[] { false, true })
            {
                for (int port = 0; port < 16; port++)
                {
                    for (int addr = 0x08; addr < 0x78; addr++)
                    {
                        byte[] d;
                        int rs = Read(gpus[g], port, ddc, addr, 1, out d);
                        if (!statusHist.ContainsKey(rs)) statusHist[rs] = 0;
                        statusHist[rs]++;
                        if (rs == 0)
                        {
                            responders++;
                            byte[] dump;
                            int rs2 = Read(gpus[g], port, ddc, addr, 16, out dump);
                            Console.WriteLine("  RESPONDER  port=" + port + " ddc=" + ddc
                                + " addr=0x" + addr.ToString("X2")
                                + "  reg0x00[16]=" + (rs2 == 0 ? Hex(dump) : "(read16 status " + rs2 + ")"));
                        }
                    }
                }
            }
        }

        Console.WriteLine("--- status code histogram (code: count) ---");
        foreach (var kv in statusHist) Console.WriteLine("  " + kv.Key + ": " + kv.Value);
        Console.WriteLine("total responders: " + responders);
        if (unload != null) unload();
        Console.WriteLine("done");
    }
}
