@echo off
cd /d "%~dp0"

pwsh.exe -NoProfile -Command "& { $local = (Get-Location).Path; pi remove npm:pi-claude-code; $settings = Get-Content -Raw (Join-Path $HOME '.pi/agent/settings.json') | ConvertFrom-Json; if (@($settings.packages) -notcontains $local) { pi install $local; $settings = Get-Content -Raw (Join-Path $HOME '.pi/agent/settings.json') | ConvertFrom-Json }; $settings.packages | ForEach-Object { Write-Host ('[Loaded] ' + $(if ($_ -is [string]) { $_ } else { $_.source })) }; try { & pi @args } finally { pi remove $local; Write-Host '[Removed] temporary extension config' } }" %*
