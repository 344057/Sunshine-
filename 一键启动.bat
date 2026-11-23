@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Sunshine 实用工具站 - 本地服务
echo 正在启动 Sunshine 实用工具站本地服务，请稍候...
where python >nul 2>nul
if %errorlevel%==0 (
  python start_local.py
) else (
  where py >nul 2>nul
  if %errorlevel%==0 (
    py start_local.py
  ) else (
    echo.
    echo 未检测到 Python。请改用直接双击 index.html 的方式离线使用，
    echo 所有功能均可正常运行，无需安装任何软件。
    echo.
    pause
  )
)
pause
