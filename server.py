#!/usr/bin/env python3
"""Простой оффлайн-сервер для карты Снежинска. Не требует интернета."""
import http.server
import socketserver
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get('PORT', 8765))
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

class Server(socketserver.TCPServer):
    allow_reuse_address = True

if __name__ == '__main__':
    with Server(('0.0.0.0', PORT), Handler) as httpd:
        print(f'Карта доступна по адресу: http://localhost:{PORT}')
        print('Для остановки нажмите Ctrl+C')
        httpd.serve_forever()
