# Ambient Music Mixer - tiny static web server for Windows without Python (PowerShell 5.1+, no admin rights needed).
# Serves this folder on http://localhost:<port>/ only. The page runs in BROWSER MODE: presets are kept in your
# browser (localStorage). Started by "Start Mixer.bat"; close this window to stop.
param([int]$Port = 8765, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$types = @{ '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8';
            '.json' = 'application/json; charset=utf-8'; '.ogg' = 'audio/ogg'; '.svg' = 'image/svg+xml' }
$allowed = '^(index\.html|favicon\.svg|css/[\w.-]+\.css|js/[\w.-]+\.js|stems/[\w.-]+\.ogg|data/kit\.json|data/default_mixes\.json)$'

$listener = $null
for ($p = $Port; $p -lt $Port + 10; $p++) {
    try {
        $l = New-Object System.Net.HttpListener
        $l.Prefixes.Add("http://localhost:$p/")
        $l.Start(); $listener = $l; $Port = $p; break
    } catch { }
}
if (-not $listener) { Write-Host "Could not open a port between $Port and $($Port + 9)."; exit 1 }

$url = "http://localhost:$Port/"
Write-Host ""
Write-Host "  Ambient Music Mixer (browser mode, no Python): $url"
Write-Host "  Presets are saved in your browser. Close this window to stop the mixer."
Write-Host ""
if (-not $NoBrowser) { Start-Process $url }

function Send($ctx, [int]$code, [byte[]]$bytes, [string]$type, [bool]$cache) {
    $r = $ctx.Response
    $r.StatusCode = $code; $r.ContentType = $type; $r.ContentLength64 = $bytes.Length
    $r.Headers['Cache-Control'] = $(if ($cache) { 'public, max-age=3600' } else { 'no-store' })
    $r.Headers['X-Content-Type-Options'] = 'nosniff'
    if ($ctx.Request.HttpMethod -ne 'HEAD') { $r.OutputStream.Write($bytes, 0, $bytes.Length) }
    $r.OutputStream.Close()
}
$notFound = [Text.Encoding]::UTF8.GetBytes('{"error": "not found"}')

while ($listener.IsListening) {
    $async = $listener.BeginGetContext($null, $null)
    while (-not $async.AsyncWaitHandle.WaitOne(500)) { }   # lets Ctrl+C through
    $ctx = $listener.EndGetContext($async)
    try {
        $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
        if ($path -eq '') { $path = 'index.html' }
        if ($ctx.Request.HttpMethod -eq 'PUT' -and $path -eq 'api/selftest') {   # report of index.html?selftest=1
            $sr = New-Object IO.StreamReader($ctx.Request.InputStream)
            $body = $sr.ReadToEnd(); if ($body.Length -gt 16384) { $body = $body.Substring(0, 16384) }
            [IO.File]::WriteAllText((Join-Path $root 'data\selftest_result.txt'), $body)
            Send $ctx 200 ([Text.Encoding]::UTF8.GetBytes('{"ok": true}')) 'application/json' $false
            continue
        }
        if (($ctx.Request.HttpMethod -ne 'GET' -and $ctx.Request.HttpMethod -ne 'HEAD') -or $path -notmatch $allowed -or $path.Contains('..')) {
            Send $ctx 404 $notFound 'application/json' $false; continue
        }
        $file = Join-Path $root ($path -replace '/', '\')
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Send $ctx 404 $notFound 'application/json' $false; continue }
        $ext = [IO.Path]::GetExtension($file).ToLower()
        $type = $types[$ext]; if (-not $type) { $type = 'application/octet-stream' }
        Send $ctx 200 ([IO.File]::ReadAllBytes($file)) $type ($path.StartsWith('stems/'))
    } catch {
        try { $ctx.Response.Abort() } catch { }
    }
}
