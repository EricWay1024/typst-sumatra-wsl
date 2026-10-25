using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// Sumatra -> one loopback HTTP request -> the running VS Code window's IPC.
// The installed VS Code CLI remains the fallback; no editor extension is needed.
internal static class OpenInVSCode {
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private sealed class Metadata {
        public int port { get; set; }
        public string token { get; set; }
    }

    private sealed class Position {
        public string filepath { get; set; }
        public int line { get; set; }
        public int column { get; set; }
        public bool opened { get; set; }
    }

    private static string Quote(string value) {
        // wsl.exe parses its switches before ordinary Windows argv unquoting.
        // In particular, a quoted "--distribution" is treated as a shell command.
        if (value.Length > 0 && !Regex.IsMatch(value, "[\\s\"]")) return value;
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(uint processId);

    private static void AllowEditorForeground() {
        // The Sumatra-launched child can pass its foreground permission to Code.
        // Without the usual Code.exe CLI process, IPC alone may only flash the
        // taskbar instead of bringing the editor forward. Do not grant ASFW_ANY.
        try {
            using (Process current = Process.GetCurrentProcess()) {
                foreach (Process process in Process.GetProcessesByName("Code")) {
                    using (process) {
                        try {
                            if (process.SessionId == current.SessionId && process.MainWindowHandle != IntPtr.Zero)
                                AllowSetForegroundWindow((uint)process.Id);
                        } catch { /* A Code subprocess may exit while being enumerated. */ }
                    }
                }
            }
        } catch { /* Foreground permission is best effort, as with the normal CLI. */ }
    }

    private static void WriteUtf8(Stream stream, string text) {
        byte[] bytes = Encoding.UTF8.GetBytes(text + "\n");
        using (stream) stream.Write(bytes, 0, bytes.Length);
    }

    private static string Run(string executable, string[] arguments, bool electronCli) {
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = executable;
        start.Arguments = String.Join(" ", Array.ConvertAll(arguments, Quote));
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.StandardOutputEncoding = Encoding.UTF8;
        start.StandardErrorEncoding = Encoding.UTF8;
        start.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        if (electronCli) {
            start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            start.EnvironmentVariables.Remove("VSCODE_DEV");
        }
        using (Process process = Process.Start(start)) {
            var output = process.StandardOutput.ReadToEndAsync();
            var errors = process.StandardError.ReadToEndAsync();
            process.WaitForExit();
            string text = output.GetAwaiter().GetResult();
            string errorText = errors.GetAwaiter().GetResult();
            if (process.ExitCode != 0) throw new Exception(Path.GetFileName(executable) + " failed: " + errorText);
            return text;
        }
    }

    private static Position ResolveHttp(Metadata metadata, int record, bool openEditor) {
        if (metadata.port < 1 || metadata.port > 65535 || String.IsNullOrEmpty(metadata.token))
            throw new Exception("Invalid Typst bridge metadata");
        // Never send the local capability token to a host supplied by a file.
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
            "http://127.0.0.1:" + metadata.port + "/resolve");
        request.Proxy = null;
        request.Method = "POST";
        request.ContentType = "application/json";
        request.Headers["Authorization"] = "Bearer " + metadata.token;
        request.Timeout = 22000;
        request.ReadWriteTimeout = 22000;
        request.ServicePoint.Expect100Continue = false;
        byte[] body = Encoding.UTF8.GetBytes("{\"id\":" + record.ToString(CultureInfo.InvariantCulture)
            + (openEditor ? ",\"open\":true}" : "}"));
        request.ContentLength = body.Length;
        using (Stream stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
        using (WebResponse response = request.GetResponse())
        using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            return Json.Deserialize<Position>(reader.ReadToEnd());
    }

    private static Position Resolve(string metadataFile, string linuxPath, string distro, int record, bool openEditor) {
        Metadata metadata = Json.Deserialize<Metadata>(File.ReadAllText(metadataFile));
        try {
            return ResolveHttp(metadata, record, openEditor);
        } catch (WebException error) {
            if (error.Response != null) {
                using (WebResponse response = error.Response)
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    string body = reader.ReadToEnd();
                    throw new Exception("Typst source lookup failed: " + body, error);
                }
            }
            // Recover a stopped bridge (or unavailable WSL localhost forwarding).
            // Do not repeat a timed-out lookup: it may still be running.
            if (error.Status != WebExceptionStatus.ConnectFailure &&
                error.Status != WebExceptionStatus.SendFailure &&
                error.Status != WebExceptionStatus.ReceiveFailure) throw;
            string wsl = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wsl.exe");
            string result = Run(wsl, new string[] {
                "--distribution", distro, "--exec", "/bin/sh", "-c",
                "exec \"$HOME/bin/typst-sumatra\" resolve \"$1\" \"$2\"",
                "typst-sumatra", linuxPath, record.ToString(CultureInfo.InvariantCulture)
            }, false);
            return Json.Deserialize<Position>(result);
        }
    }

    [STAThread]
    private static int Main(string[] args) {
        string directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        try {
            bool printCommand = false, resolveOnly = false;
            List<string> positional = new List<string>();
            foreach (string argument in args) {
                if (argument.Equals("-PrintCommand", StringComparison.OrdinalIgnoreCase)) printCommand = true;
                else if (argument.Equals("--resolve-only", StringComparison.OrdinalIgnoreCase)) resolveOnly = true;
                else positional.Add(argument);
            }
            if (positional.Count < 1 || positional.Count > 3)
                throw new Exception("Usage: open-in-vscode SOURCE [LINE [COLUMN]] [-PrintCommand|--resolve-only]");
            string original = positional[0];
            string source = original.Replace('\\', '/');
            int line = positional.Count > 1 ? Int32.Parse(positional[1], CultureInfo.InvariantCulture) : 1;
            int column = positional.Count > 2 ? Int32.Parse(positional[2], CultureInfo.InvariantCulture) : 1;
            string distro = null;
            Match remote = Regex.Match(source, @"^//(?:wsl\.localhost|wsl\$)/([^/]+)(/.*)$", RegexOptions.IgnoreCase);
            if (remote.Success) { distro = remote.Groups[1].Value; source = remote.Groups[2].Value; }
            else if (source.StartsWith("/", StringComparison.Ordinal)) distro = "Ubuntu";

            if (source.EndsWith(".typst-sync.json", StringComparison.OrdinalIgnoreCase)) {
                if (line < 1) throw new Exception("Invalid PDF source record");
                if (distro == null) throw new Exception("Typst metadata must name a WSL file");
                string metadataFile = "\\\\wsl.localhost\\" + distro + source.Replace('/', '\\');
                bool openEditor = !printCommand && !resolveOnly;
                if (openEditor) AllowEditorForeground();
                Position position = Resolve(metadataFile, source, distro, line, openEditor);
                if (position == null || String.IsNullOrEmpty(position.filepath) || position.line < 1 || position.column < 1)
                    throw new Exception("The Typst bridge returned an invalid source position");
                if (openEditor && position.opened) return 0;
                source = position.filepath;
                line = position.line;
                column = position.column;
            }
            line = Math.Max(1, line);
            column = Math.Max(1, column);
            if (resolveOnly) {
                WriteUtf8(Console.OpenStandardOutput(), Json.Serialize(new { filepath = source, line = line, column = column }));
                return 0;
            }

            string codeRoot = Environment.GetEnvironmentVariable("TYPST_SUMATRA_CODE_ROOT");
            if (String.IsNullOrEmpty(codeRoot)) codeRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\Microsoft VS Code");
            string code = Path.Combine(codeRoot, "Code.exe");
            string launcher = Path.Combine(codeRoot, @"bin\code.cmd");
            // Follow code.cmd: recent VS Code releases use a versioned resources directory.
            Match match = Regex.Match(File.ReadAllText(launcher), "\"([^\"\r\n]+cli\\.js)\"");
            if (!match.Success) throw new Exception("The VS Code CLI entry point was not found");
            string cli = Path.GetFullPath(match.Groups[1].Value.Replace("%~dp0", Path.GetDirectoryName(launcher) + "\\"));
            if (!File.Exists(code) || !File.Exists(cli)) throw new Exception("The installed VS Code CLI was not found");
            List<string> codeArgs = new List<string>(new string[] { cli, "--reuse-window" });
            if (distro != null) { codeArgs.Add("--remote"); codeArgs.Add("wsl+" + distro); }
            codeArgs.Add("--goto");
            codeArgs.Add(source + ":" + line + ":" + column);
            if (printCommand) {
                WriteUtf8(Console.OpenStandardOutput(), Json.Serialize(new { executable = code, arguments = codeArgs.ToArray() }));
                return 0;
            }
            Run(code, codeArgs.ToArray(), true);
            return 0;
        } catch (Exception error) {
            File.AppendAllText(Path.Combine(directory, "open-in-vscode-errors.log"),
                DateTime.UtcNow.ToString("o") + " " + error + Environment.NewLine);
            WriteUtf8(Console.OpenStandardError(), error.Message);
            return 1;
        }
    }
}
