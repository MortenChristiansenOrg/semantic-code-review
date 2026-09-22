/** Best-effort, bounded diagnostics. Never close handles or terminate processes. */
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";

type FileUser = { pid: number; name: string; path: string };

// RmGetList cannot accept directories. Query a bounded group of files, then
// narrow a matching group to one file without one registry operation per file.
// https://learn.microsoft.com/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist
// https://learn.microsoft.com/windows/win32/api/restartmanager/nf-restartmanager-rmregisterresources
const windowsLookup = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ReviewFileUsers {
  [StructLayout(LayoutKind.Sequential)]
  public struct UniqueProcess { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME started; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct ProcessInfo {
    public UniqueProcess process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string service;
    public uint type, status, session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint session, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint session, uint count, string[] files, uint apps, IntPtr appList, uint services, IntPtr serviceList);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] apps, ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  public static ProcessInfo[] Users(string[] files) {
    uint session;
    int code = RmStartSession(out session, 0, new StringBuilder(33));
    if (code != 0) throw new InvalidOperationException("RmStartSession: " + code);
    try {
      code = RmRegisterResources(session, (uint)files.Length, files, 0, IntPtr.Zero, 0, IntPtr.Zero);
      if (code != 0) throw new InvalidOperationException("RmRegisterResources: " + code);
      uint needed, count = 0, reasons = 0;
      ProcessInfo[] apps = null;
      for (int attempt = 0; attempt < 3; attempt++) {
        code = RmGetList(session, out needed, ref count, apps, ref reasons);
        if (code == 0) { if (apps == null) return new ProcessInfo[0]; Array.Resize(ref apps, (int)count); return apps; }
        if (code != 234 || needed > 1024) throw new InvalidOperationException("RmGetList: " + code);
        count = needed; apps = new ProcessInfo[count];
      }
      return new ProcessInfo[0];
    } finally { RmEndSession(session); }
  }
}
'@
$paths = @([Console]::In.ReadToEnd() | ConvertFrom-Json)
$users = @([ReviewFileUsers]::Users([string[]]$paths))
while ($users.Count -gt 0 -and $paths.Count -gt 1) {
  $middle = [int][Math]::Floor($paths.Count / 2)
  $left = @($paths[0..($middle - 1)])
  $found = @([ReviewFileUsers]::Users([string[]]$left))
  if ($found.Count -gt 0) { $paths = $left; $users = $found }
  else { $paths = @($paths[$middle..($paths.Count - 1)]); $users = @([ReviewFileUsers]::Users([string[]]$paths)) }
}
@($users | ForEach-Object { @{ pid = $_.process.pid; name = $_.name; path = $paths[0] } }) | ConvertTo-Json -Compress
`;

function candidateFiles(root: string): string[] {
  const files: string[] = [], pending = [root];
  for (let visited = 0; pending.length && files.length < 256 && visited < 1024; visited++) {
    const file = pending.pop();
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isFile()) files.push(file);
      else if (stat.isDirectory()) {
        // opendir bounds traversal even for very large managed checkouts.
        const directory = fs.opendirSync(file);
        try {
          for (let entry = directory.readSync(); entry && pending.length < 1024; entry = directory.readSync()) pending.push(path.join(file, entry.name));
        } finally { directory.closeSync(); }
      }
    } catch { /* An inaccessible path must not hide the original cleanup error. */ }
  }
  return files;
}

export function fileUsers(file: string): FileUser[] {
  try {
    let users: FileUser[];
    const options = { encoding: "utf8" as const, timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
    if (process.platform === "win32") {
      const files = candidateFiles(file);
      if (!files.length) return [];
      // Pathnames travel as JSON on stdin, never as executable PowerShell text.
      const output = childProcess.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsLookup], { ...options, input: JSON.stringify(files) });
      const parsed = output.trim() ? JSON.parse(output) : [];
      users = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      const directory = fs.lstatSync(file).isDirectory();
      let output: string;
      try { output = childProcess.execFileSync("lsof", ["-Fpcn", ...(directory ? ["+D", file] : ["--", file])], options); }
      catch (error) {
        // A directory query can return matches and exit 1 for unmatched files.
        if (error.status !== 1 || typeof error.stdout !== "string") throw error;
        output = error.stdout;
      }
      users = []; let pid = 0, name = "";
      for (const line of output.split("\n")) {
        if (line.startsWith("p")) { pid = Number(line.slice(1)); name = ""; }
        else if (line.startsWith("c")) name = line.slice(1);
        else if (line.startsWith("n") && pid) users.push({ pid, name, path: line.slice(1) });
      }
    }
    return users.filter((user) => Number.isInteger(user.pid) && user.pid > 0 && typeof user.name === "string" && typeof user.path === "string")
      .filter((user, index, all) => all.findIndex((other) => other.pid === user.pid && other.path === user.path) === index).slice(0, 8);
  } catch { return []; } // Missing tools, permissions, and lookup timeouts are normal.
}

export function cleanupFailure(error: NodeJS.ErrnoException, fallback: string, retry: string): string {
  const file = typeof error.path === "string" ? error.path : fallback;
  const code = error.code ? ` (${error.code})` : "";
  const users = ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(error.code) ? fileUsers(file) : [];
  const owners = users.length
    ? ` Processes using these files: ${users.map((user) => `${user.name || "Process"} (PID ${user.pid}): ${JSON.stringify(user.path)}`).join("; ")}.`
    : " No holding process could be identified; the path may be locked or inaccessible.";
  return `Could not clean ${JSON.stringify(file)}${code}: ${error.message}.${owners} Close applications or terminals using this location, or release the lock and check access permissions. ${retry} Do not delete review files manually.`;
}
