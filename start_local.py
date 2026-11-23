# -*- coding: utf-8 -*-
"""Sunshine 实用工具站 - 本地一键服务
启动后：电脑用 localhost 访问；手机连同一 WiFi，用局域网地址访问。
按 Ctrl+C 停止。
"""
import http.server
import socketserver
import socket
import os
import webbrowser
import threading

PORT = 8791
HERE = os.path.dirname(os.path.abspath(__file__))


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, fmt, *args):
        pass  # 静默运行，不刷屏


ip = lan_ip()
line = '=' * 56
print('\n' + line)
print('  Sunshine 实用工具站 - 本地服务已启动')
print(line)
print('  本机访问     http://localhost:%d/' % PORT)
if ip:
    print('  手机 / 局域网 http://%s:%d/' % (ip, PORT))
    print('  (手机需与电脑连接同一个 WiFi)')
print('  停止服务     在此窗口按 Ctrl+C')
print(line + '\n')

threading.Timer(1.0, lambda: webbrowser.open('http://localhost:%d/' % PORT)).start()

with socketserver.TCPServer(('0.0.0.0', PORT), Handler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n服务已停止。')
