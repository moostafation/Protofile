"""Keep one window open: selecting 10 videos and choosing "Generate
subtitles" from the right-click menu starts 10 processes, which would load
10 copies of the model. The first process listens on a local port and the
others hand their files to it and exit."""

import json
import os
import socket
import threading

PORT = 47391


def claim():
    """Return a listening socket if this is the first instance, else None."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows: refuse shared binds
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        sock.bind(("127.0.0.1", PORT))
        sock.listen()
        return sock
    except OSError:
        sock.close()
        return None


def send(paths, start):
    """Pass files to the running instance. False if none is reachable."""
    message = json.dumps({"paths": [os.path.abspath(p) for p in paths], "start": start})
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=3) as conn:
            conn.sendall(message.encode("utf-8"))
        return True
    except OSError:
        return False


def serve(sock, on_message):
    """Call on_message(paths, start) (from a background thread) for every
    message another instance sends."""
    def loop():
        while True:
            try:
                conn, _ = sock.accept()
            except OSError:
                return
            with conn:
                conn.settimeout(3)
                data = b""
                try:
                    while chunk := conn.recv(65536):
                        data += chunk
                    msg = json.loads(data.decode("utf-8"))
                    paths = [p for p in msg.get("paths", []) if isinstance(p, str)]
                    on_message(paths, bool(msg.get("start")))
                except (OSError, ValueError, AttributeError):
                    pass

    threading.Thread(target=loop, daemon=True).start()
