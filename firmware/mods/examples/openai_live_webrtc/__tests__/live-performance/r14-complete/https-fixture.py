#!/usr/bin/env python3
"""Bounded private TLS fixture for device worker delay/cancellation tests."""
import argparse
import http.server
import json
import socket
import ssl
import subprocess
import threading
import time
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--private', required=True)
parser.add_argument('--public-config', required=True)
parser.add_argument('--seconds', type=int, default=10800)
args = parser.parse_args()
private = Path(args.private)
private.mkdir(mode=0o700, parents=True, exist_ok=True)
probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
probe.connect(('8.8.8.8', 53))
address = probe.getsockname()[0]
probe.close()
key, certificate = private / 'fixture.key', private / 'fixture.crt'
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
                '-subj', '/CN=R14 private TLS fixture', '-addext', f'subjectAltName=IP:{address}',
                '-keyout', str(key), '-out', str(certificate)],
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
key.chmod(0o600)
metrics = {'requests': 0, 'completed': 0, 'disconnected': 0}
lock = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 65536:
            self.send_error(400)
            return
        self.rfile.read(length)  # Never retain/log queries, headers or request bodies.
        with lock:
            metrics['requests'] += 1
        time.sleep(2)
        body = json.dumps({'status': 'completed', 'output': [
            {'type': 'web_search_call', 'status': 'completed'},
            {'type': 'message', 'content': [{'type': 'output_text', 'text': 'R14 fixture answer.',
              'annotations': [{'type': 'url_citation', 'url': 'https://docs.espressif.com/', 'title': 'Fixture source'}]}]},
        ]}).encode()
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            with lock:
                metrics['completed'] += 1
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            with lock:
                metrics['disconnected'] += 1
        (private / 'fixture-metrics.json').write_text(json.dumps(metrics) + '\n')


server = http.server.ThreadingHTTPServer(('0.0.0.0', 0), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(str(certificate), str(key))
server.socket = context.wrap_socket(server.socket, server_side=True)
public = {'url': f'https://{address}:{server.server_port}/responses', 'certificate': certificate.read_text()}
Path(args.public_config).write_text(json.dumps(public, indent=2) + '\n')
threading.Timer(args.seconds, server.shutdown).start()
print('R14 private TLS fixture ready', flush=True)
server.serve_forever()
server.server_close()
