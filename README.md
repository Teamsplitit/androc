# LAN Share P2P (No Server File Storage)

Direct file transfer between sender and receiver browsers on same Wi-Fi.

## What this version does

- Sender selects multiple files
- App generates share code (and QR link)
- Receiver joins using code or QR link
- Receiver can pick specific files or use Download All
- Files stream directly sender -> receiver over WebRTC data channel
- Server does not store uploaded file contents
- Share code/signaling expire automatically (default 30 minutes)
- Receiver verifies each file with byte-count + CRC32 integrity check

## 10GB and large-file support

- Designed for very large files by chunked streaming.
- For multi-GB downloads, receiver should use Chrome/Edge and click `Choose Save Folder`.
- In that mode, incoming data is written directly to disk using File System Access API.

Without folder mode support, browser falls back to in-memory Blob download, which is not reliable for very large files.

## Requirements

- Node.js 18+
- Both devices on same network (or reachable LAN/VPN)
- Modern browsers with WebRTC support

## Run

```bash
npm install
npm start
```

Open:

- `http://localhost:8080` on sender machine
- `http://<sender-local-ip>:8080` on receiver machine

## Config

- `PORT` default: `8080`
- `SHARE_TTL_MS` default: `1800000` (30 minutes)

Example:

```bash
PORT=8080 SHARE_TTL_MS=3600000 npm start
```

## Privacy model

- Stored on server: temporary share metadata (code + file names/sizes + WebRTC signaling messages)
- Not stored on server: actual file contents

## Security hardening included

- Stronger 8-character random share code by default
- Signaling relay restricted to peers in the same share only
- Input validation for file metadata and signaling payloads
- WebSocket message-size limits and join attempt rate limiting
- Filename sanitization on sender and receiver to prevent path-like names
- Basic secure response headers (`nosniff`, `DENY`, `no-referrer`)

## Security note

No app can promise \"zero risk\" in all environments. This implementation substantially reduces practical risk on trusted LANs, and it detects transfer corruption before finalizing files.

## Limitations

- Sender browser tab must stay open during transfer.
- If sender disconnects, transfer stops.
- Very large files on Safari/older browsers may be constrained by memory/API support.

## Copyright

Copyright © Devi Srinivas Vasamsetti Technologies
