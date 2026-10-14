param([Parameter(Mandatory=$true)][string]$ProjectPath)
$ErrorActionPreference = 'Stop'
$resolvedProject = (Resolve-Path -LiteralPath $ProjectPath).Path
& node (Join-Path $PSScriptRoot 'service-launch.mjs') $resolvedProject
exit $LASTEXITCODE
