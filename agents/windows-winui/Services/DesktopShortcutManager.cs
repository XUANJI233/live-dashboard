using System.Runtime.InteropServices;
using System.Text;

namespace LiveDashboardAgent.Services;

public sealed record DesktopShortcutResult(bool Changed, bool Ok, string Message);

internal static class DesktopShortcutManager
{
    private const string ShortcutFileName = "Live Dashboard Agent.lnk";
    private const string AppDescription = "Live Dashboard Agent";

    public static DesktopShortcutResult Create(InstallScope scope, string executablePath)
    {
        try
        {
            var target = Path.GetFullPath(executablePath);
            if (!File.Exists(target))
            {
                return new DesktopShortcutResult(false, false, "主程序不存在，未创建桌面快捷方式。");
            }

            var shortcutPath = ShortcutPath(scope);
            Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath)!);

            var shellLink = CreateShellLink();
            shellLink.SetPath(target);
            shellLink.SetWorkingDirectory(Path.GetDirectoryName(target));
            shellLink.SetDescription(AppDescription);
            shellLink.SetIconLocation(target, 0);

            var persistFile = (IPersistFile)shellLink;
            persistFile.Save(shortcutPath, true);
            return new DesktopShortcutResult(true, true, "已创建桌面快捷方式。");
        }
        catch (Exception ex)
        {
            return new DesktopShortcutResult(false, false, $"桌面快捷方式创建失败: {ex.Message}");
        }
    }

    public static DesktopShortcutResult Remove(InstallScope scope, string executablePath)
    {
        try
        {
            var shortcutPath = ShortcutPath(scope);
            if (!File.Exists(shortcutPath))
            {
                return new DesktopShortcutResult(false, true, "桌面快捷方式不存在。");
            }

            var expectedTarget = Path.GetFullPath(executablePath);
            var actualTarget = ReadTargetPath(shortcutPath);
            if (!string.Equals(actualTarget, expectedTarget, StringComparison.OrdinalIgnoreCase))
            {
                return new DesktopShortcutResult(false, true, "桌面快捷方式目标不匹配，已保留。");
            }

            File.Delete(shortcutPath);
            return new DesktopShortcutResult(true, true, "已删除桌面快捷方式。");
        }
        catch (Exception ex)
        {
            return new DesktopShortcutResult(false, false, $"桌面快捷方式删除失败: {ex.Message}");
        }
    }

    private static string ShortcutPath(InstallScope scope)
    {
        var desktop = scope == InstallScope.AllUsers
            ? Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory)
            : Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        return Path.Combine(desktop, ShortcutFileName);
    }

    private static string? ReadTargetPath(string shortcutPath)
    {
        var shellLink = CreateShellLink();
        ((IPersistFile)shellLink).Load(shortcutPath, 0);
        var builder = new StringBuilder(512);
        shellLink.GetPath(builder, builder.Capacity, IntPtr.Zero, 0);
        return builder.ToString();
    }

    private static IShellLinkW CreateShellLink()
    {
        var type = Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046"));
        return (IShellLinkW)Activator.CreateInstance(type!)!;
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW
    {
        void GetPath(
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile,
            int cchMaxPath,
            IntPtr pfd,
            uint fFlags);

        void GetIDList(out IntPtr ppidl);

        void SetIDList(IntPtr pidl);

        void GetDescription(
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName,
            int cchMaxName);

        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);

        void GetWorkingDirectory(
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir,
            int cchMaxPath);

        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string? pszDir);

        void GetArguments(
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs,
            int cchMaxPath);

        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string? pszArgs);

        void GetHotkey(out short pwHotkey);

        void SetHotkey(short wHotkey);

        void GetShowCmd(out int piShowCmd);

        void SetShowCmd(int iShowCmd);

        void GetIconLocation(
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath,
            int cchIconPath,
            out int piIcon);

        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);

        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);

        void Resolve(IntPtr hwnd, uint fFlags);

        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("0000010b-0000-0000-C000-000000000046")]
    private interface IPersistFile
    {
        void GetClassID(out Guid pClassID);

        void IsDirty();

        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);

        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, bool fRemember);

        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);

        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }
}
