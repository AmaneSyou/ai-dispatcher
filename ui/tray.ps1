# AI 调度器的托盘图标：由调度器启动；调度器退出（或连不上）时自动消失。
# 参数通过环境变量传入：DISPATCHER_PORT / TOKEN / ICON / NODE / CLI / PID
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$base = "http://127.0.0.1:$($env:DISPATCHER_PORT)"
$headers = @{ 'x-dispatcher-token' = $env:DISPATCHER_TOKEN }

# 复用 cli.ts app：调度器已在运行时它只负责打开面板窗口
function Open-Panel {
	Start-Process -FilePath $env:DISPATCHER_NODE -ArgumentList @('--disable-warning=ExperimentalWarning', "`"$($env:DISPATCHER_CLI)`"", 'app') -WindowStyle Hidden
}

function Close-Tray {
	$timer.Stop()
	$icon.Visible = $false
	$icon.Dispose()
	[System.Windows.Forms.Application]::Exit()
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = New-Object System.Drawing.Icon($env:DISPATCHER_ICON)
$icon.Text = 'AI 调度器'
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('打开面板')
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miStatus = $menu.Items.Add('状态：连接中…')
$miStatus.Enabled = $false
$miTest = $menu.Items.Add('发一条测试通知')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miQuit = $menu.Items.Add('彻底退出调度器')
$icon.ContextMenuStrip = $menu

$miOpen.add_Click({ Open-Panel })
$miTest.add_Click({ Show-Note '测试通知' '能看到这条，说明通知正常。它会留在通知中心里。' $false })
$icon.add_MouseDoubleClick({ Open-Panel })
$icon.add_BalloonTipClicked({ Open-Panel })
$miQuit.add_Click({
	$answer = [System.Windows.Forms.MessageBox]::Show(
		'确定要彻底退出调度器吗？正在运行的任务会被停止（下次启动时标为“需要你处理”），排队中的任务会保留。',
		'AI 调度器', 'YesNo', 'Question')
	if ($answer -ne 'Yes') { return }
	try {
		Invoke-RestMethod -Method Post -Uri "$base/api/shutdown" -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
	} catch {}
	Close-Tray
})

# 每 5 秒刷新一次提示文字；任务或 AI 的状态变化时弹通知（哪些要通知在面板“设置 → 通知”里选）
$script:seen = @{}
$script:down = @{}
$script:first = $true
$script:fails = 0

# 某家 AI 现在为什么不能接活；能接活返回空字符串
function Agent-Down($a) {
	if (-not $a.enabled) { return '' }
	if ($a.pause) { return "额度用完，约 $(([datetime]$a.pause.until).ToLocalTime().ToString('M/d HH:mm')) 恢复" }
	if ($a.block) { return "额度保护：$($a.block)" }
	if ($a.name -ne 'dsh' -and -not $a.available) { return '不可用（未登录或找不到程序）' }
	if ($a.name -eq 'dsh' -and $a.budget -gt 0 -and ($a.usage.tokensIn + $a.usage.tokensOut) -ge $a.budget) { return '今日预算用完' }
	return ''
}

$AGENT_NAME = @{ dsh = 'DSH'; claude = 'Claude'; codex = 'Codex' }

# 新式通知（会留在通知中心）：Windows 按“应用 ID”显示名字和图标，所以在你的用户注册表里登记一个
# “AI 调度器”。只写 HKCU 下这一项，不碰别的；撤销用：node src\cli.ts notify-off
$AUMID = 'AIDispatcher.Tray'
$script:notifier = $null
function Register-Toast {
	try {
		$png = Join-Path $env:DISPATCHER_WORK 'tray-icon.png'
		# 图标换过（ico 比 png 新）就重新生成
		if (-not (Test-Path $png) -or (Get-Item $env:DISPATCHER_ICON).LastWriteTime -gt (Get-Item $png).LastWriteTime) {
			$ico = New-Object System.Drawing.Icon($env:DISPATCHER_ICON, 256, 256)
			$bmp = $ico.ToBitmap()
			$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
			$bmp.Dispose(); $ico.Dispose()
		}
		$key = "HKCU:\Software\Classes\AppUserModelId\$AUMID"
		if (-not (Test-Path $key)) { [void](New-Item -Path $key) }
		Set-ItemProperty -Path $key -Name DisplayName -Value 'AI 调度器'
		Set-ItemProperty -Path $key -Name IconUri -Value $png
		[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
		[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
		$script:notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AUMID)
	} catch {
		$script:notifier = $null
	}
}
if (-not (Test-Path (Join-Path $env:DISPATCHER_WORK 'notify-legacy'))) { Register-Toast }

# 先用新式通知；不支持或出错时退回托盘气泡，保证总能看到
function Show-Note([string]$title, [string]$body, [bool]$warn) {
	if ($script:notifier) {
		try {
			$e = { param($s) [System.Security.SecurityElement]::Escape($s) }
			$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
			$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$(& $e $title)</text><text>$(& $e $body)</text><text placement='attribution'>双击托盘图标打开面板</text></binding></visual></toast>")
			$script:notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))
			return
		} catch {}
	}
	if (-not $body) { $body = ' ' }
	$icon.ShowBalloonTip(10000, $title, $body, $(if ($warn) { 'Warning' } else { 'Info' }))
}
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
	try {
		$s = Invoke-RestMethod -Uri "$base/api/state" -Headers $headers -TimeoutSec 4
		$script:fails = 0
		$running = @($s.tasks | Where-Object { $_.status -in 'running', 'gating' }).Count
		$queued = @($s.tasks | Where-Object { $_.status -eq 'queued' }).Count
		$waiting = @($s.tasks | Where-Object { $_.status -in 'passed', 'needs_human', 'planned' }).Count
		$summary = "运行 $running · 排队 $queued · 等你处理 $waiting"
		# 托盘提示文字最长 63 个字符
		$tip = "AI 调度器：$summary"
		if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
		$icon.Text = $tip
		$miStatus.Text = $summary
		$n = $s.notify
		# 这一轮的所有新动态攒在一起，只弹一次，免得一下子刷屏
		$msgs = New-Object System.Collections.ArrayList
		$warn = $false
		foreach ($t in $s.tasks) {
			$key = [string]$t.id
			$prev = $script:seen[$key]
			if (-not $script:first -and $prev -ne $t.status) {
				if ($t.status -eq 'passed' -and $n.passed) {
					$extra = if ($t.reason) { "（$($t.reason)）" } else { '' }
					[void]$msgs.Add("#$($t.id) 待你验收：$($t.title)$extra")
				} elseif ($t.status -in 'needs_human', 'failed' -and $n.needsHuman) {
					[void]$msgs.Add("#$($t.id) 需要你处理：$($t.title)`n$($t.reason)"); $warn = $true
				} elseif ($t.status -eq 'planned' -and $n.planned) {
					[void]$msgs.Add("#$($t.id) 拆分方案待你批准：$($t.title)")
				} elseif ($t.status -eq 'merged' -and $t.kind -eq 'plan' -and $n.done) {
					[void]$msgs.Add("大任务 #$($t.id) 全部完成并合并：$($t.title)")
				}
			}
			$script:seen[$key] = $t.status
		}
		foreach ($a in $s.agents) {
			$why = Agent-Down $a
			$prev = $script:down[$a.name]
			if (-not $script:first -and $n.agentDown -and $prev -ne $why) {
				$nm = $AGENT_NAME[$a.name]
				if ($why) { [void]$msgs.Add("$nm 暂停派发：$why"); $warn = $true }
				elseif ($prev) { [void]$msgs.Add("$nm 恢复可用") }
			}
			$script:down[$a.name] = $why
		}
		if ($msgs.Count -eq 1) {
			$lines = ([string]$msgs[0]) -split "`n", 2
			$body = if ($lines.Count -gt 1) { $lines[1] } else { '' }
			Show-Note $lines[0] $body $warn
		} elseif ($msgs.Count -gt 1) {
			$body = ($msgs | ForEach-Object { ($_ -split "`n")[0] }) -join "`n"
			Show-Note "$($msgs.Count) 条新动态" $body $warn
		}
		$script:first = $false
	} catch {
		# 连续 3 次连不上，说明调度器已经退出，托盘图标跟着消失
		$script:fails++
		if ($script:fails -ge 3) { Close-Tray }
	}
})
$timer.Start()

# 每秒确认调度器进程还在；它退出后托盘自己正常收起，避免被强杀留下“残影”图标
$watch = New-Object System.Windows.Forms.Timer
$watch.Interval = 1000
$watch.add_Tick({
	try { [void][System.Diagnostics.Process]::GetProcessById([int]$env:DISPATCHER_PID) } catch { $watch.Stop(); Close-Tray }
})
$watch.Start()
[System.Windows.Forms.Application]::Run()
