param(
    [string]$ProjectRoot = "C:\NEW\media-analyzer-v2",
    [string]$ServerBaseUrl = "http://127.0.0.1:8899"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:results = @()

function Add-Result {
    param(
        [string]$Name,
        [bool]$Passed,
        [string]$Details
    )
    $script:results += [pscustomobject]@{
        Name = $Name
        Passed = $Passed
        Details = $Details
    }
}

function Read-Text {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        throw "Missing file: $Path"
    }
    return [System.IO.File]::ReadAllText($Path)
}

$stage1 = Join-Path $ProjectRoot "stage1"
$indexPath = Join-Path $stage1 "index.html"
$appPath = Join-Path $stage1 "app.js"
$decentralizedPath = Join-Path $stage1 "decentralized.js"
$networkCfgPath = Join-Path $stage1 "network-config.js"

try {
    # 1) Required files
    foreach ($p in @($indexPath, $appPath, $decentralizedPath, $networkCfgPath)) {
        Add-Result -Name "File exists: $p" -Passed (Test-Path $p) -Details ""
    }
    $hfClientPath = Join-Path $stage1 "hf-client.js"
    Add-Result -Name "File exists: $hfClientPath" -Passed (Test-Path $hfClientPath) -Details ""

    $cssPath = Join-Path $stage1 "styles.css"
    Add-Result -Name "File exists: $cssPath" -Passed (Test-Path $cssPath) -Details ""

    $index = Read-Text $indexPath
    $app = Read-Text $appPath
    $decent = Read-Text $decentralizedPath
    $cfg = Read-Text $networkCfgPath
    $hfc = Read-Text $hfClientPath
    $css = Read-Text $cssPath

    # 2) Script load order
    $orderPattern = 'nostr\.bundle\.min\.js" defer></script>\s*<script src="\./network-config\.js" defer></script>\s*<script src="\./decentralized\.js" defer></script>\s*<script src="\./hf-client\.js" defer></script>\s*<script src="\./app\.js" defer></script>'
    Add-Result -Name "Script order (nostr->network-config->decentralized->hf-client->app)" -Passed ([regex]::IsMatch($index, $orderPattern)) -Details ""

    # 3) Network config includes SOS public relays
    $requiredRelays = @(
        "wss://relay.snort.social",
        "wss://nos.lol",
        "wss://nostr-relay.xbytez.io",
        "wss://nostr-02.uid.ovh"
    )
    foreach ($relay in $requiredRelays) {
        Add-Result -Name "Relay configured: $relay" -Passed ($cfg.Contains($relay)) -Details ""
    }

    # 4) Network config includes SOS blossom servers
    $requiredBlossom = @(
        "https://files.sovbit.host",
        "https://blossom.band",
        "https://blossom.primal.net",
        "https://blossom.nostr.build",
        "https://nostr.build"
    )
    foreach ($b in $requiredBlossom) {
        Add-Result -Name "Blossom configured: $b" -Passed ($cfg.Contains($b)) -Details ""
    }

    # 5) Decentralized logic checks
    Add-Result -Name "Blossom upload function exists" -Passed ($decent.Contains("async function uploadToBlossom")) -Details ""
    Add-Result -Name "Report publish to relay exists" -Passed ($decent.Contains("async function publishReport")) -Details ""
    Add-Result -Name "Relay query for history exists" -Passed ($decent.Contains("loadRelayReports")) -Details ""
    Add-Result -Name "Relay history preserves fullData snapshot" -Passed ($decent.Contains("fullData: report.fullData || null")) -Details ""
    Add-Result -Name "Config priority uses network-config first" -Passed ($decent.Contains("relayUrls = fromUserRelays.length") -and $decent.Contains("blossomServers = fromUserBlossom.length")) -Details ""

    # 6) App flow checks
    Add-Result -Name "App uploads to Blossom before analysis" -Passed ($app.Contains("blossomUrl = await net.uploadToBlossom(file)")) -Details ""
    Add-Result -Name "App sends media_url to backend" -Passed ($app.Contains("fd.append('media_url', blossomUrl)")) -Details ""
    Add-Result -Name "App publishes report history" -Passed ($app.Contains("net.publishReport")) -Details ""
    Add-Result -Name "App supports API base storage" -Passed ($app.Contains("const API_BASE_KEY = 'tof_api_base'")) -Details ""
    Add-Result -Name "App has API base save button logic" -Passed ($app.Contains("btnSaveApiBase") -and $app.Contains("localStorage.setItem(API_BASE_KEY")) -Details ""
    Add-Result -Name "App has history report fallback renderer" -Passed ($app.Contains("buildFallbackReportFromHistory") -and $app.Contains("resolveHistoryReport")) -Details ""

    # 7) UI checks (GitHub mode)
    Add-Result -Name "Index contains API base input" -Passed ($index.Contains('id="apiBase"')) -Details ""
    Add-Result -Name "Index contains API base save button" -Passed ($index.Contains('id="btnSaveApiBase"')) -Details ""

    # 8) HF Client direct API checks
    Add-Result -Name "HF Client verifyToken exists" -Passed ($hfc.Contains("async function verifyToken")) -Details ""
    Add-Result -Name "HF Client analyzeImage exists" -Passed ($hfc.Contains("async function analyzeImage")) -Details ""
    Add-Result -Name "HF Client calls HF whoami directly" -Passed ($hfc.Contains("huggingface.co/api/whoami-v2")) -Details ""
    Add-Result -Name "App uses _hasBackend() branch" -Passed ($app.Contains("_hasBackend()")) -Details ""
    Add-Result -Name "App calls HF_CLIENT.verifyToken" -Passed ($app.Contains("HF_CLIENT.verifyToken")) -Details ""
    Add-Result -Name "App calls HF_CLIENT.analyzeImage" -Passed ($app.Contains("HF_CLIENT.analyzeImage")) -Details ""
    Add-Result -Name "App calls HF_CLIENT.analyzeVideo" -Passed ($app.Contains("HF_CLIENT.analyzeVideo")) -Details ""
    Add-Result -Name "HF Client has analyzeVideo function" -Passed ($hfc.Contains("async function analyzeVideo")) -Details ""
    Add-Result -Name "HF Client has Whisper API" -Passed ($hfc.Contains("_apiWhisper")) -Details ""
    Add-Result -Name "HF Client has ffmpeg decompose" -Passed ($hfc.Contains("_decomposeVideo")) -Details ""
    Add-Result -Name "HF Client has fallback decompose" -Passed ($hfc.Contains("_fallbackDecompose")) -Details ""

    # 9) New pipeline steps matching backend
    Add-Result -Name "HF Client has P_QUESTIONS prompt" -Passed ($hfc.Contains("P_QUESTIONS")) -Details ""
    Add-Result -Name "HF Client has P_SUMMARY prompt" -Passed ($hfc.Contains("P_SUMMARY")) -Details ""
    Add-Result -Name "HF Client has P_VALIDATION prompt" -Passed ($hfc.Contains("P_VALIDATION")) -Details ""
    Add-Result -Name "HF Client has P_EVIDENCE_FILTER prompt" -Passed ($hfc.Contains("P_EVIDENCE_FILTER")) -Details ""
    Add-Result -Name "HF Client text_merge step in video" -Passed ($hfc.Contains("text_merge")) -Details ""
    Add-Result -Name "HF Client investigative_questions step" -Passed ($hfc.Contains("investigative_questions")) -Details ""
    Add-Result -Name "HF Client frame_reinvestigation step" -Passed ($hfc.Contains("frame_reinvestigation")) -Details ""
    Add-Result -Name "HF Client summary step in video" -Passed ($hfc.Contains("step: 11, name: 'summary'")) -Details ""
    Add-Result -Name "HF Client audio segmentation" -Passed ($hfc.Contains("audioSegments")) -Details ""
    Add-Result -Name "HF Client dual AI classifier (first+mid)" -Passed ($hfc.Contains("framesToClassify")) -Details ""
    Add-Result -Name "HF Client validation object returned" -Passed ($hfc.Contains("validation: validation")) -Details ""
    Add-Result -Name "HF Client evidence_filter object returned" -Passed ($hfc.Contains("evidence_filter: evidenceFilter")) -Details ""
    Add-Result -Name "HF Client Whisper WAV fallback" -Passed ($hfc.Contains("audio/wav")) -Details ""
    Add-Result -Name "HF Client smart frame selection" -Passed ($hfc.Contains("selectedTimes") -or $hfc.Contains("smart")) -Details ""

    # 10) Media preview in feed
    Add-Result -Name "Index has heroMedia container" -Passed ($index.Contains('id="heroMedia"')) -Details ""
    Add-Result -Name "Index has resultMedia container" -Passed ($index.Contains('id="resultMedia"')) -Details ""
    Add-Result -Name "App renders video in hero card" -Passed ($app.Contains("heroMedia") -and $app.Contains("vid.src = mUrl")) -Details ""
    Add-Result -Name "App renders media in result screen" -Passed ($app.Contains("resultMedia") -and $app.Contains("media_url")) -Details ""
    Add-Result -Name "CSS has hero-media styles" -Passed ($css.Contains(".hero-media")) -Details ""
    Add-Result -Name "CSS has hi-media thumbnail styles" -Passed ($css.Contains(".hi-media")) -Details ""
    Add-Result -Name "CSS has result-media styles" -Passed ($css.Contains(".result-media")) -Details ""
    Add-Result -Name "App shows media thumbnail in history items" -Passed ($app.Contains("hi-media") -and $app.Contains("hi-play-icon")) -Details ""
    Add-Result -Name "Mobile bottom-nav min height 56px" -Passed ($css.Contains("bottom-nav{height:56px")) -Details ""
    Add-Result -Name "Mobile nav-tab min font .7rem" -Passed ($css.Contains("nav-tab{font-size:.7") -or $css.Contains("nav-tab{font-size:.72")) -Details ""

    # 8) Optional live server check
    try {
        $health = Invoke-RestMethod -Uri "$ServerBaseUrl/api/health" -Method GET -TimeoutSec 6
        $ok = $false
        if ($null -ne $health -and ($health.ok -eq $true -or $health.ok -eq "True")) { $ok = $true }
        Add-Result -Name "Live server health check" -Passed $ok -Details ($health | ConvertTo-Json -Compress)
    } catch {
        Add-Result -Name "Live server health check" -Passed $false -Details "Server not reachable at $ServerBaseUrl"
    }
}
catch {
    Add-Result -Name "QA runner internal error" -Passed $false -Details $_.Exception.Message
}

$passedCount = @($script:results | Where-Object { $_.Passed }).Count
$totalCount = @($script:results).Count
$failed = @($script:results | Where-Object { -not $_.Passed })

$reportPath = Join-Path $ProjectRoot "qa\STAGE1_QA_REPORT.md"
$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

$lines = @()
$lines += "# Stage1 QA Report"
$lines += ""
$lines += "Generated: $ts"
$lines += ""
$lines += "Summary: $passedCount / $totalCount checks passed"
$lines += ""
$lines += "| Check | Status | Details |"
$lines += "|---|---|---|"
foreach ($r in $script:results) {
    $status = if ($r.Passed) { "PASS" } else { "FAIL" }
    $details = ($r.Details -replace "\|", "/")
    $lines += "| $($r.Name) | $status | $details |"
}

if ($failed.Count -gt 0) {
    $lines += ""
    $lines += "## Failed Checks"
    foreach ($f in $failed) {
        $lines += "- $($f.Name): $($f.Details)"
    }
}

[System.IO.File]::WriteAllLines($reportPath, $lines)

Write-Host "QA complete: $passedCount/$totalCount passed"
Write-Host "Report: $reportPath"

if ($failed.Count -gt 0) {
    exit 1
}
exit 0
