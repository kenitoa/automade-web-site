$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $workspaceRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $nodePath) {
  $programRoot = Join-Path $env:LOCALAPPDATA 'Programs'
  if (Test-Path -LiteralPath $programRoot) {
    foreach ($candidateRoot in (Get-ChildItem -LiteralPath $programRoot -Directory -Filter 'nodejs-*')) {
      $candidate = Get-ChildItem -LiteralPath $candidateRoot.FullName -Filter node.exe -File -Recurse | Select-Object -First 1
      if ($candidate) { $nodePath = $candidate.FullName; break }
    }
  }
}
if (-not $nodePath) { throw 'Node.js 22.16 이상을 설치한 후 다시 실행하세요.' }
& $nodePath -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||major===22&&minor>=16?0:1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.16 이상이 필요합니다.' }
$nodeDirectory = Split-Path -Parent $nodePath
$env:Path = "$nodeDirectory;$env:Path"
$npmPath = Join-Path $nodeDirectory 'npm.cmd'
if (-not (Test-Path -LiteralPath $npmPath)) { throw 'npm을 찾지 못했습니다. Node.js 설치를 확인하세요.' }
$dataDirectory = Join-Path $workspaceRoot '.data'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$hashFile = Join-Path $dataDirectory 'dependency-lock.sha256'
$lockHash = (Get-FileHash -LiteralPath (Join-Path $workspaceRoot 'package-lock.json') -Algorithm SHA256).Hash
$previousHash = if (Test-Path -LiteralPath $hashFile) { (Get-Content -LiteralPath $hashFile -Raw).Trim() } else { '' }
if (-not (Test-Path -LiteralPath (Join-Path $workspaceRoot 'node_modules')) -or $previousHash -ne $lockHash) {
  Write-Host '필요한 도구를 설치합니다. 처음 한 번은 인터넷 연결이 필요합니다.'
  & $npmPath ci
  if ($LASTEXITCODE -ne 0) { throw '의존성 설치 실패. 인터넷 연결과 npm 상태를 확인하세요.' }
  Set-Content -LiteralPath $hashFile -Value $lockHash -Encoding ASCII
}
& $nodePath (Join-Path $PSScriptRoot 'launch.mjs')
exit $LASTEXITCODE
