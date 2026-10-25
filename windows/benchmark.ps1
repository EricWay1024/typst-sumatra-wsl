param(
    [Parameter(Mandatory = $true)][string]$Before,
    [Parameter(Mandatory = $true)][string]$After,
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][int]$Record,
    [int]$Count = 5
)
$ErrorActionPreference = 'Stop'
# Both children have a native Windows parent. PrintCommand includes source
# resolution but skips the final VS Code CLI invocation and GUI focus change.
function Measure-Launcher([string]$Label, [string]$Executable) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = '"' + $Source + '" ' + $Record + ' 1 -PrintCommand'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $start.WorkingDirectory = $env:SystemRoot
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $process = [Diagnostics.Process]::Start($start)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $timer.Stop()
        if ($process.ExitCode -ne 0) { throw $errors.Result }
        [pscustomobject]@{
            label = $Label
            milliseconds = [Math]::Round($timer.Elapsed.TotalMilliseconds, 2)
            output = $output.Result.Trim()
        } | ConvertTo-Json -Compress
    } finally { $process.Dispose() }
}
for ($i = 0; $i -lt $Count; $i++) {
    Measure-Launcher 'before' $Before
    Measure-Launcher 'after' $After
}
