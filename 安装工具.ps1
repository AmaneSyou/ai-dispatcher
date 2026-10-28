# AI 调度器：把 AI 干活可能用到的工具装进程序目录下的 tools 文件夹（不改系统 PATH，删掉 tools 文件夹即卸载）。
# 用法：右键本文件 →“使用 PowerShell 运行”，按提示逐项选择。只从官方地址下载，并核对官方公布的校验值。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$root = Join-Path $PSScriptRoot 'tools'
$dl = Join-Path $root 'downloads'
New-Item -ItemType Directory -Force $root, $dl | Out-Null

function Ask([string]$q) {
	$a = Read-Host "$q [y/N]"
	return $a -match '^(y|yes|是)$'
}

function Done([string]$msg) { Write-Host "  ✔ $msg" -ForegroundColor Green }

Write-Host ''
Write-Host '===== 安装 AI 调度器的工具（装在 tools 文件夹里） =====' -ForegroundColor Cyan
Write-Host '需要 Node.js 24 或更高版本（pnpm 通过 Node 自带的 corepack 安装）。'
Write-Host ''

# ---------- pnpm ----------
if (Ask '安装 pnpm？（前端项目装依赖用，约 60 MB）') {
	$ver = Read-Host '  pnpm 版本（直接回车 = 最新版；项目 package.json 里写了 packageManager 时填那个版本）'
	if (-not $ver) { $ver = 'latest' }
	$env:COREPACK_HOME = Join-Path $root 'corepack'
	$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
	New-Item -ItemType Directory -Force (Join-Path $root 'bin'), $env:COREPACK_HOME, (Join-Path $root 'pnpm-store') | Out-Null
	& corepack enable pnpm --install-directory (Join-Path $root 'bin')
	& corepack install -g "pnpm@$ver"
	Done "pnpm $(& (Join-Path $root 'bin\pnpm.cmd') --version)"
}

# ---------- Rust ----------
if (Ask '安装 Rust？（Rust / Tauri 项目编译用，约 800 MB；需要已装 Visual Studio 的 C++ 生成工具）') {
	$u = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
	$exe = Join-Path $dl 'rustup-init.exe'
	Invoke-WebRequest $u -OutFile $exe -UseBasicParsing
	Invoke-WebRequest "$u.sha256" -OutFile "$exe.sha256" -UseBasicParsing
	$expect = ([IO.File]::ReadAllText("$exe.sha256") -split '\s+')[0].Trim().ToLower()
	$got = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
	if ($expect -ne $got) { throw "rustup-init.exe 校验值不对（期望 $expect，实际 $got），已停止" }
	Done 'rustup-init.exe 校验通过'
	$env:RUSTUP_HOME = Join-Path $root 'rust\rustup'
	$env:CARGO_HOME = Join-Path $root 'rust\cargo'
	& $exe -y --no-modify-path --profile minimal --default-toolchain stable --component rustfmt --component clippy
	Done (& (Join-Path $root 'rust\cargo\bin\rustc.exe') --version)
}

# ---------- Python ----------
if (Ask '安装 Python 便携版？（AI 写小脚本时用，约 30 MB）') {
	$ver = Read-Host '  Python 版本（例如 3.15.2；直接回车 = 自动找最新的正式版）'
	if (-not $ver) {
		$html = (Invoke-WebRequest 'https://www.python.org/ftp/python/' -UseBasicParsing).Content
		$cands = [regex]::Matches($html, 'href="(3\.\d+\.\d+)/"') | ForEach-Object { [version]$_.Groups[1].Value } | Sort-Object -Descending -Unique
		foreach ($v in $cands) {
			try { Invoke-WebRequest "https://www.python.org/ftp/python/$v/python-$v-embed-amd64.zip" -Method Head -UseBasicParsing | Out-Null; $ver = "$v"; break } catch {}
		}
	}
	$f = "python-$ver-embed-amd64.zip"
	$zip = Join-Path $dl $f
	Invoke-WebRequest "https://www.python.org/ftp/python/$ver/$f" -OutFile $zip -UseBasicParsing
	# 官方发布页上的 SHA-256 中间夹着换行标记，去掉 HTML 标签后再比
	$page = (Invoke-WebRequest "https://www.python.org/downloads/release/python-$($ver -replace '\.','')/" -UseBasicParsing).Content
	$i = $page.IndexOf("$f</a>")
	if ($i -lt 0) { $i = $page.IndexOf($f) }
	$plain = ($page.Substring($i, [Math]::Min(3000, $page.Length - $i)) -replace '<[^>]+>', '')
	$got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
	if (-not $plain.Contains($got)) { throw "Python 压缩包的校验值和官方发布页对不上（实际 $got），已停止" }
	Done 'Python 压缩包校验通过'
	Expand-Archive $zip -DestinationPath (Join-Path $root 'python') -Force
	$sig = Get-AuthenticodeSignature (Join-Path $root 'python\python.exe')
	if ($sig.Status -ne 'Valid') { throw "python.exe 的数字签名无效：$($sig.Status)" }
	Done "$(& (Join-Path $root 'python\python.exe') --version)（签名：$($sig.SignerCertificate.Subject -replace ',.*','')）"
}

Remove-Item -Recurse -Force $dl -ErrorAction SilentlyContinue
Write-Host ''
Write-Host '完成。在调度器面板的“环境检查”里能看到每样工具是否已安装。' -ForegroundColor Cyan
Read-Host '按回车关闭'
