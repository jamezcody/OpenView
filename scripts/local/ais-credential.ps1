param([ValidateSet('Read', 'Save')][string]$Action = 'Read')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class OpenViewAisVault {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Credential {
    public int Flags, Type;
    public string TargetName, Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr value);
  [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredWrite(ref Credential value, int flags);
  [DllImport("Advapi32.dll")] static extern void CredFree(IntPtr value);
  const string Target = "OpenView/AISStream";
  public static string Read() {
    IntPtr pointer;
    if (!CredRead(Target, 1, 0, out pointer)) {
      if (Marshal.GetLastWin32Error() == 1168) return "";
      throw new InvalidOperationException("Unable to read the OpenView AIS credential.");
    }
    try {
      var value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      return Marshal.PtrToStringUni(value.CredentialBlob, value.CredentialBlobSize / 2);
    } finally { CredFree(pointer); }
  }
  public static void Save(string value) {
    if (String.IsNullOrWhiteSpace(value) || value.Length > 1280)
      throw new InvalidOperationException("An AISStream key is required.");
    var blob = Marshal.StringToCoTaskMemUni(value.Trim());
    try {
      var credential = new Credential { Type=1, TargetName=Target, UserName="AISStream",
        CredentialBlob=blob, CredentialBlobSize=Encoding.Unicode.GetByteCount(value.Trim()), Persist=2,
        Comment="OpenView ship snapshot collection" };
      if (!CredWrite(ref credential, 0)) throw new InvalidOperationException("Unable to save the OpenView AIS credential.");
    } finally { Marshal.ZeroFreeCoTaskMemUnicode(blob); }
  }
}
'@
if ($Action -eq 'Save') {
  # Automation supplies stdin; interactive setup uses a masked prompt.
  if ([Console]::IsInputRedirected) {
    [OpenViewAisVault]::Save([Console]::In.ReadToEnd())
  } else {
    $secureValue = Read-Host 'AISStream API key' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try { [OpenViewAisVault]::Save([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  }
  Write-Output 'AISStream credential saved in Windows Credential Manager.'
} else {
  # Read is used only by the local Node process through a private stdout pipe.
  [Console]::Write([OpenViewAisVault]::Read())
}
