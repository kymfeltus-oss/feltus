# FELTUS LABS - DETERMINISTIC LOCAL STARTUP

$ErrorActionPreference = "Stop"

$ProjectRoot =
    Split-Path -Parent $MyInvocation.MyCommand.Path

Set-Location $ProjectRoot

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " FELTUS LABS" -ForegroundColor Cyan
Write-Host " PRIVATE LOCAL PLATFORM" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""


function Test-FeltusHealth {

    try {

        $health =
            Invoke-RestMethod `
                -Uri "http://127.0.0.1:8080/api/health" `
                -Method GET `
                -TimeoutSec 3

        return (
            $health.status -eq "online" -and
            $health.authenticated -eq $true
        )

    }
    catch {
        return $false
    }
}


function Test-FeltusAI {

    try {

        $ai =
            Invoke-RestMethod `
                -Uri "http://127.0.0.1:8080/api/ai/status" `
                -Method GET `
                -TimeoutSec 10

        return (
            $ai.status -eq "online" -and
            $ai.engine -eq "ollama"
        )

    }
    catch {
        return $false
    }
}


function Test-Ollama {

    try {

        $null =
            Invoke-RestMethod `
                -Uri "http://127.0.0.1:11434/api/tags" `
                -Method GET `
                -TimeoutSec 3

        return $true

    }
    catch {
        return $false
    }
}


Write-Host "[1/7] Docker" -ForegroundColor DarkCyan

docker info *> $null

if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is unavailable."
}

Write-Host "      READY" -ForegroundColor Green


Write-Host "[2/7] FELTUS infrastructure" -ForegroundColor DarkCyan

$requiredContainers = @(
    "supabase_db_feltus-labs",
    "supabase_kong_feltus-labs",
    "supabase_auth_feltus-labs",
    "supabase_rest_feltus-labs"
)

$runningContainers =
    @(docker ps --format "{{.Names}}")

$missingContainers =
    @(
        $requiredContainers |
            Where-Object {
                $_ -notin $runningContainers
            }
    )

if ($missingContainers.Count -gt 0) {

    Write-Host "      Starting local infrastructure..." -ForegroundColor Yellow

    npx supabase start

    if ($LASTEXITCODE -ne 0) {
        throw "FELTUS infrastructure startup failed."
    }
}

$runningContainers =
    @(docker ps --format "{{.Names}}")

$stillMissing =
    @(
        $requiredContainers |
            Where-Object {
                $_ -notin $runningContainers
            }
    )

if ($stillMissing.Count -gt 0) {

    throw (
        "Required containers unavailable: " +
        ($stillMissing -join ", ")
    )
}

Write-Host "      READY" -ForegroundColor Green


Write-Host "[3/7] Gateway configuration" -ForegroundColor DarkCyan

$config =
    (
        docker exec `
            supabase_kong_feltus-labs `
            cat /home/kong/kong.yml
    ) -join "`n"

if ($LASTEXITCODE -ne 0) {
    throw "FELTUS gateway configuration unavailable."
}

$key =
    [regex]::Match(
        $config,
        'sb_publishable_[A-Za-z0-9_-]+'
    )

if (-not $key.Success) {
    throw "FELTUS publishable key could not be resolved."
}

$env:FELTUS_PUBLISHABLE_KEY =
    $key.Value

$env:FELTUS_LOCAL_DEV_MODE =
    "1"

$env:FELTUS_ENV =
    "development"

$env:NODE_ENV =
    "development"

$env:FELTUS_HOST =
    "127.0.0.1"

$env:FELTUS_PORT =
    "8080"

$env:FELTUS_PUBLIC_URL =
    "http://127.0.0.1:8080"

$env:FELTUS_GATEWAY_URL =
    if ($env:FELTUS_LOCAL_GATEWAY_URL) {
        $env:FELTUS_LOCAL_GATEWAY_URL
    }
    else {
        "http://127.0.0.1:54321"
    }

$env:FELTUS_API_KEY = ""

$env:FELTUS_ALLOWED_ORIGINS =
    "http://127.0.0.1:8080,http://localhost:8080,https://kyemba.tailb2f227.ts.net"

$env:FELTUS_AI_MODEL =
    "llama3:8b"

$env:FELTUS_AI_BASE_URL =
    if ($env:FELTUS_LOCAL_AI_BASE_URL) {
        $env:FELTUS_LOCAL_AI_BASE_URL
    }
    else {
        "http://127.0.0.1:11434"
    }

Write-Host "      READY" -ForegroundColor Green


Write-Host "[4/7] Native Ollama" -ForegroundColor DarkCyan

$ollamaReady =
    Test-Ollama

if (-not $ollamaReady) {

    $ollamaCommand =
        Get-Command `
            ollama `
            -ErrorAction SilentlyContinue

    if (-not $ollamaCommand) {
        throw "Native Ollama is unavailable."
    }

    Write-Host "      Starting Ollama..." -ForegroundColor Yellow

    Start-Process `
        -FilePath $ollamaCommand.Source `
        -ArgumentList "serve" `
        -WindowStyle Hidden

    for (
        $attempt = 0;
        $attempt -lt 20;
        $attempt++
    ) {

        Start-Sleep `
            -Milliseconds 500

        if (Test-Ollama) {
            $ollamaReady = $true
            break
        }
    }
}

if (-not $ollamaReady) {
    throw "Ollama failed to become available."
}

Write-Host "      READY" -ForegroundColor Green


Write-Host "[5/7] FELTUS application server" -ForegroundColor DarkCyan

if (Test-FeltusHealth) {

    Write-Host "      Existing FELTUS server is healthy." -ForegroundColor Green

    if (-not (Test-FeltusAI)) {
        throw "Existing FELTUS server is healthy but AI health failed."
    }

    Write-Host "      REUSED" -ForegroundColor Green

}
else {

    $listener =
        Get-NetTCPConnection `
            -LocalPort 8080 `
            -State Listen `
            -ErrorAction SilentlyContinue

    if ($listener) {

        $listenerPids =
            @(
                $listener |
                    Select-Object `
                        -ExpandProperty OwningProcess `
                        -Unique
            )

        foreach ($listenerPid in $listenerPids) {

            $process =
                Get-CimInstance `
                    Win32_Process `
                    -Filter "ProcessId = $listenerPid" `
                    -ErrorAction SilentlyContinue

            $commandLine =
                [string]$process.CommandLine

            $isFeltusNode =
                (
                    $process.Name -match '^node(\.exe)?$'
                ) -and
                (
                    $commandLine -match 'src[\\/]server\.js'
                )

            if (-not $isFeltusNode) {

                throw (
                    "Port 8080 is occupied by a non-FELTUS process. PID: " +
                    $listenerPid
                )
            }

            Write-Host "      Removing stale FELTUS server..." -ForegroundColor Yellow

            Stop-Process `
                -Id $listenerPid `
                -Force
        }

        Start-Sleep `
            -Milliseconds 500
    }


    $runtimeDirectory =
        Join-Path `
            $ProjectRoot `
            ".feltus-runtime"

    New-Item `
        -ItemType Directory `
        -Path $runtimeDirectory `
        -Force |
        Out-Null


    $stdoutLog =
        Join-Path `
            $runtimeDirectory `
            "server.stdout.log"

    $stderrLog =
        Join-Path `
            $runtimeDirectory `
            "server.stderr.log"


    Remove-Item `
        $stdoutLog `
        -Force `
        -ErrorAction SilentlyContinue

    Remove-Item `
        $stderrLog `
        -Force `
        -ErrorAction SilentlyContinue
    # Run the Node server inside its own persistent PowerShell host.
    # The worker inherits the already-loaded FELTUS environment without
    # writing credentials or keys to disk.

    $workerPath =
        Join-Path `
            $runtimeDirectory `
            "server-host.ps1"

    $workerSource = @"
`$ErrorActionPreference = "Stop"

Set-Location `$env:FELTUS_PROJECT_ROOT

node .\src\server.js

exit `$LASTEXITCODE
"@

    Set-Content `
        -Path $workerPath `
        -Value $workerSource `
        -Encoding UTF8

    $env:FELTUS_PROJECT_ROOT =
        $ProjectRoot

    $serverProcess =
        Start-Process `
            -FilePath "powershell.exe" `
            -ArgumentList (
                "-NoProfile -ExecutionPolicy Bypass -File `"" +
                $workerPath +
                "`""
            ) `
            -WorkingDirectory $ProjectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutLog `
            -RedirectStandardError $stderrLog `
            -PassThru


    $serverReady =
        $false


    for (
        $attempt = 0;
        $attempt -lt 40;
        $attempt++
    ) {

        Start-Sleep `
            -Milliseconds 500

        if ($serverProcess.HasExited) {
            break
        }

        if (Test-FeltusHealth) {

            $serverReady =
                $true

            break
        }
    }


    if (-not $serverReady) {

        Write-Host ""
        Write-Host "FELTUS SERVER ERROR LOG" -ForegroundColor Red

        if (Test-Path $stderrLog) {

            Get-Content `
                $stderrLog `
                -Tail 30
        }

        throw "FELTUS server failed its startup health gate."
    }


    Write-Host "      STARTED" -ForegroundColor Green
}


Write-Host "[6/7] Runtime health gates" -ForegroundColor DarkCyan

if (-not (Test-FeltusHealth)) {
    throw "FELTUS API health gate failed."
}

if (-not (Test-FeltusAI)) {
    throw "FELTUS AI health gate failed."
}

Write-Host "      API: ONLINE" -ForegroundColor Green
Write-Host "      AUTH: ACTIVE" -ForegroundColor Green
Write-Host "      AI: ONLINE" -ForegroundColor Green


Write-Host "[7/7] Private Tailscale route" -ForegroundColor DarkCyan

$tailscale =
    Get-Command `
        tailscale `
        -ErrorAction SilentlyContinue

if ($tailscale) {

    $serveStatus =
        (
            tailscale serve status 2>$null
        ) -join "`n"

    $serveReady =
        (
            $serveStatus -match "tailnet only"
        ) -and
        (
            $serveStatus -match "127\.0\.0\.1:8080"
        )

    if ($serveReady) {
        Write-Host "      READY" -ForegroundColor Green
    }

    if (-not $serveReady) {
        Write-Host "      NOT CONFIGURED" -ForegroundColor Yellow
    }
}

if (-not $tailscale) {
    Write-Host "      CLI NOT AVAILABLE" -ForegroundColor Yellow
}


$gitignorePath =
    Join-Path `
        $ProjectRoot `
        ".gitignore"

if (Test-Path $gitignorePath) {

    $gitignoreContent =
        Get-Content `
            $gitignorePath `
            -Raw

    if (
        $gitignoreContent -notmatch
        '(?m)^\.feltus-runtime/'
    ) {

        Add-Content `
            -Path $gitignorePath `
            -Value "`n.feltus-runtime/"
    }
}


Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " FELTUS LABS READY" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

Write-Host "Local Console:" -ForegroundColor Gray
Write-Host "http://127.0.0.1:8080" -ForegroundColor Cyan

Write-Host ""
Write-Host "Private Tailnet Console:" -ForegroundColor Gray
Write-Host "https://kyemba.tailb2f227.ts.net" -ForegroundColor Cyan
Write-Host ""

Start-Process "http://127.0.0.1:8080"

