using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace OpenView.Setup;

internal static class CredentialManager
{
    private const int CredentialTypeGeneric = 1;
    private const int CredentialPersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;
    private const int MaximumCredentialBytes = 2560;
    private const string FccTarget = "OpenView/FCC";
    private const string OpenCellIdTarget = "OpenView/OpenCellID";

    public static bool HasFcc => Exists(FccTarget);
    public static bool HasOpenCellId => Exists(OpenCellIdTarget);

    public static void ValidateFccReplacement(string username, string token)
    {
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(token))
            throw new InvalidOperationException("Replacing the FCC credential requires both a username and API token.");
        ValidateValue(username, "FCC username");
        ValidateValue(token, "FCC token");
    }

    public static void ValidateOpenCellIdReplacement(string token)
    {
        if (string.IsNullOrWhiteSpace(token))
            throw new InvalidOperationException("Replacing the OpenCellID credential requires an API token.");
        ValidateValue(token, "OpenCellID token");
    }

    public static void SaveFcc(string username, string token)
    {
        ValidateFccReplacement(username, token);
        Save(FccTarget, username.Trim(), token);
    }

    public static void SaveOpenCellId(string token)
    {
        ValidateOpenCellIdReplacement(token);
        Save(OpenCellIdTarget, "OpenCellID", token);
    }

    public static void RemoveAll()
    {
        var errors = new List<Exception>();
        foreach (var target in new[] { FccTarget, OpenCellIdTarget })
        {
            try { Delete(target); }
            catch (Exception error) { errors.Add(error); }
        }
        if (errors.Count != 0)
            throw new AggregateException("One or more credentials could not be removed.", errors);
    }

    private static void ValidateValue(string value, string label)
    {
        if (Encoding.Unicode.GetByteCount(value) > MaximumCredentialBytes)
            throw new InvalidOperationException($"The {label} is too long for Windows Credential Manager.");
    }

    private static void Save(string target, string username, string secret)
    {
        var secretBytes = Encoding.Unicode.GetByteCount(secret);
        var blob = Marshal.StringToCoTaskMemUni(secret);
        try
        {
            var credential = new NativeCredential
            {
                Type = CredentialTypeGeneric,
                TargetName = target,
                CredentialBlobSize = secretBytes,
                CredentialBlob = blob,
                Persist = CredentialPersistLocalMachine,
                UserName = username,
                Comment = "Optional OpenView offline data-refresh credential",
            };
            if (!CredWrite(ref credential, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows Credential Manager rejected the credential.");
        }
        finally
        {
            Marshal.ZeroFreeCoTaskMemUnicode(blob);
        }
    }

    private static bool Exists(string target)
    {
        if (CredRead(target, CredentialTypeGeneric, 0, out var pointer))
        {
            CredFree(pointer);
            return true;
        }
        var error = Marshal.GetLastWin32Error();
        if (error == ErrorNotFound) return false;
        throw new Win32Exception(error, "Windows Credential Manager could not read credential status.");
    }

    private static void Delete(string target)
    {
        if (CredDelete(target, CredentialTypeGeneric, 0)) return;
        var error = Marshal.GetLastWin32Error();
        if (error != ErrorNotFound)
            throw new Win32Exception(error, "Windows Credential Manager could not remove the credential.");
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential
    {
        public int Flags;
        public int Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string? TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }

    [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredWrite(ref NativeCredential credential, int flags);

    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

    [DllImport("Advapi32.dll")]
    private static extern void CredFree(IntPtr credential);

    [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredDelete(string target, int type, int flags);
}
