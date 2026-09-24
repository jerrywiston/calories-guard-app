$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$javaHomes = @()
if ($env:JAVA_HOME) { $javaHomes += $env:JAVA_HOME }
$javaHomes += 'C:\Program Files\Android\Android Studio\jbr'
$javaHomes += Get-ChildItem -LiteralPath (Join-Path $projectRoot '.test-tmp\jdk21') -Directory -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty FullName
$javaHome = $javaHomes | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin\java.exe') } | Select-Object -First 1
if (-not $javaHome) {
  throw 'JDK 21 was not found. Install Android Studio or set JAVA_HOME, then retry.'
}

$androidHome = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path -LiteralPath (Join-Path $androidHome 'platforms\android-36'))) {
  throw 'Android SDK Platform 36 was not found. Install it with Android Studio or Android CLI.'
}

$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $androidHome
$env:ANDROID_SDK_ROOT = $androidHome

& npm.cmd run mobile:sync
if ($LASTEXITCODE -ne 0) { throw 'Capacitor sync failed.' }

& (Join-Path $projectRoot 'android\gradlew.bat') -p (Join-Path $projectRoot 'android') assembleDebug --no-daemon
if ($LASTEXITCODE -ne 0) { throw 'Android APK build failed.' }

$source = Join-Path $projectRoot 'android\app\build\outputs\apk\debug\app-debug.apk'
$releaseDirectory = Join-Path $projectRoot 'releases'
$destination = Join-Path $releaseDirectory 'calories-guard-debug.apk'
New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -Force
Write-Host "APK created: $destination"
