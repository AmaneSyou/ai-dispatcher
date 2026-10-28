@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ===== AI 调度器 首次安装 =====
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto oldnode

where git >nul 2>nul
if errorlevel 1 if not exist "%ProgramFiles%\Git\cmd\git.exe" goto nogit

node --disable-warning=ExperimentalWarning "%~dp0src\cli.ts" init
if errorlevel 1 goto failed
node --disable-warning=ExperimentalWarning "%~dp0src\cli.ts" shortcut
if errorlevel 1 goto failed

echo.
echo 安装完成。还差几步（详见 README.md 的“给第一次使用的人”）：
echo   1. 安装 DeepSeek Harness 桌面版，并把 DeepSeek API key 单独保存到上面提示的 deepseek.key 文件
echo   2. 可选：登录 Claude Code / Codex 命令行（有订阅才需要）
echo   3. 可选：项目要用 pnpm / Rust / Python 时，右键“安装工具.ps1”选“使用 PowerShell 运行”
echo   4. 双击桌面上的“AI 调度器”，在“环境检查”里点“开始检查”
echo.
pause
exit /b 0

:nonode
echo 没有找到 Node.js。请先安装 Node.js 24 或更高版本：https://nodejs.org/
goto end
:oldnode
echo Node.js 版本太旧，需要 24 或更高版本：https://nodejs.org/
goto end
:nogit
echo 没有找到 Git。请先安装 Git for Windows：https://git-scm.com/download/win
goto end
:failed
echo 安装没有完成，请看上面的出错信息。
:end
echo.
pause
exit /b 1
