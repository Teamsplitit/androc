const express = require('express');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 8080);
const SHARE_TTL_MS = Number(process.env.SHARE_TTL_MS || 30 * 60 * 1000);
const CODE_LEN = Number(process.env.CODE_LEN || 8);
const MAX_FILES = Number(process.env.MAX_FILES || 200);
const MAX_FILE_SIZE_BYTES = Number(process.env.MAX_FILE_SIZE_BYTES || 20 * 1024 * 1024 * 1024);
const MAX_FILE_NAME_LEN = Number(process.env.MAX_FILE_NAME_LEN || 180);
const MAX_WS_MSG_BYTES = Number(process.env.MAX_WS_MSG_BYTES || 1024 * 1024);
const MAX_JOIN_ATTEMPTS_PER_MIN = Number(process.env.MAX_JOIN_ATTEMPTS_PER_MIN || 20);

// code -> { senderId, files, createdAt, expiresAt, receiverIds:Set<string> }
const shares = new Map();
// peerId -> ws
const peers = new Map();

function now() {
  return Date.now();
}

function wsSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function makeId() {
  return crypto.randomBytes(12).toString('hex');
}

function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FILE_NAME_LEN);
}

function normalizeFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) return null;
  const normalized = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') return null;
    const name = sanitizeFileName(f.name);
    const size = Number(f.size);
    const lastModified = Number(f.lastModified || 0);
    if (!name) return null;
    if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_SIZE_BYTES) return null;
    if (!Number.isFinite(lastModified) || lastModified < 0) return null;

    normalized.push({
      name,
      size,
      type: typeof f.type === 'string' ? f.type.slice(0, 100) : 'application/octet-stream',
      lastModified,
    });
  }
  return normalized;
}

function makeCode(len = CODE_LEN) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let code = '';
  for (let i = 0; i < len; i += 1) code += chars[bytes[i] % chars.length];
  return code;
}

function uniqueCode() {
  let code = makeCode();
  while (shares.has(code)) code = makeCode();
  return code;
}

function closeShare(code, reason) {
  const share = shares.get(code);
  if (!share) return;

  wsSend(peers.get(share.senderId), { type: reason, code });
  for (const rid of share.receiverIds) {
    wsSend(peers.get(rid), { type: 'error', message: reason === 'share_expired' ? 'Share expired' : 'Share closed' });
  }
  shares.delete(code);
}

function cleanupExpiredShares() {
  const t = now();
  for (const [code, share] of shares.entries()) {
    if (share.expiresAt <= t) closeShare(code, 'share_expired');
  }
}

function canSignal(fromWs, toWs) {
  if (!fromWs || !toWs || !fromWs.code || !toWs.code) return false;
  if (fromWs.code !== toWs.code) return false;

  const share = shares.get(fromWs.code);
  if (!share) return false;

  if (fromWs.role === 'sender' && toWs.role === 'receiver') {
    return share.senderId === fromWs.peerId && share.receiverIds.has(toWs.peerId);
  }

  if (fromWs.role === 'receiver' && toWs.role === 'sender') {
    return share.senderId === toWs.peerId && share.receiverIds.has(fromWs.peerId);
  }

  return false;
}

function validateSignalData(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.kind === 'ice') {
    return data.candidate && typeof data.candidate.candidate === 'string' && data.candidate.candidate.length <= 2000;
  }
  if (data.kind === 'sdp') {
    return data.sdp
      && (data.sdp.type === 'offer' || data.sdp.type === 'answer')
      && typeof data.sdp.sdp === 'string'
      && data.sdp.sdp.length <= 200000;
  }
  return false;
}

setInterval(cleanupExpiredShares, 30 * 1000).unref();

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true, shares: shares.size, peers: peers.size });
});

app.get('/api/share/:code/qr', async (req, res) => {
  cleanupExpiredShares();
  const code = String(req.params.code || '').toUpperCase();
  if (!shares.has(code)) {
    return res.status(404).json({ error: 'Invalid or expired code' });
  }

  try {
    const link = `${req.protocol}://${req.get('host')}/?code=${encodeURIComponent(code)}`;
    const png = await QRCode.toBuffer(link, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 260,
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(png);
  } catch {
    return res.status(500).json({ error: 'Could not generate QR code' });
  }
});

wss.on('connection', (ws) => {
  ws.peerId = makeId();
  ws.role = null;
  ws.code = null;
  ws.joinAttempts = [];

  peers.set(ws.peerId, ws);
  wsSend(ws, { type: 'hello', peerId: ws.peerId });

  ws.on('message', (raw) => {
    const rawLen = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw));
    if (rawLen > MAX_WS_MSG_BYTES) {
      wsSend(ws, { type: 'error', message: 'Message too large' });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      wsSend(ws, { type: 'error', message: 'Invalid message' });
      return;
    }

    cleanupExpiredShares();

    if (msg.type === 'register_sender') {
      const files = normalizeFiles(msg.files);
      if (!files) {
        wsSend(ws, { type: 'error', message: 'Invalid file metadata' });
        return;
      }

      if (ws.code && shares.has(ws.code)) closeShare(ws.code, 'share_replaced');

      const code = uniqueCode();
      const createdAt = now();
      const expiresAt = createdAt + SHARE_TTL_MS;

      shares.set(code, {
        senderId: ws.peerId,
        files,
        createdAt,
        expiresAt,
        receiverIds: new Set(),
      });

      ws.role = 'sender';
      ws.code = code;
      wsSend(ws, { type: 'share_created', code, createdAt, expiresAt, files });
      return;
    }

    if (msg.type === 'join_share') {
      const code = String(msg.code || '').toUpperCase();

      const cutoff = now() - 60 * 1000;
      ws.joinAttempts = ws.joinAttempts.filter((t) => t >= cutoff);
      if (ws.joinAttempts.length >= MAX_JOIN_ATTEMPTS_PER_MIN) {
        wsSend(ws, { type: 'error', message: 'Too many attempts. Try again in a minute.' });
        return;
      }
      ws.joinAttempts.push(now());

      const share = shares.get(code);
      if (!share) {
        wsSend(ws, { type: 'error', message: 'Invalid or expired code' });
        return;
      }

      const senderWs = peers.get(share.senderId);
      if (!senderWs || senderWs.readyState !== WebSocket.OPEN) {
        wsSend(ws, { type: 'error', message: 'Sender is offline' });
        shares.delete(code);
        return;
      }

      ws.role = 'receiver';
      ws.code = code;
      share.receiverIds.add(ws.peerId);

      wsSend(ws, {
        type: 'share_joined',
        code,
        senderId: share.senderId,
        files: share.files,
        expiresAt: share.expiresAt,
      });

      wsSend(senderWs, {
        type: 'receiver_joined',
        code,
        receiverId: ws.peerId,
      });
      return;
    }

    if (msg.type === 'signal') {
      const to = String(msg.to || '');
      const target = peers.get(to);
      if (!target) {
        wsSend(ws, { type: 'error', message: 'Peer not found' });
        return;
      }

      if (!validateSignalData(msg.data)) {
        wsSend(ws, { type: 'error', message: 'Invalid signaling payload' });
        return;
      }

      if (!canSignal(ws, target)) {
        wsSend(ws, { type: 'error', message: 'Unauthorized signaling target' });
        return;
      }

      wsSend(target, {
        type: 'signal',
        from: ws.peerId,
        data: msg.data,
      });
      return;
    }

    if (msg.type === 'ping') {
      wsSend(ws, { type: 'pong', t: now() });
      return;
    }

    wsSend(ws, { type: 'error', message: 'Unknown message type' });
  });

  ws.on('close', () => {
    peers.delete(ws.peerId);

    if (ws.role === 'sender' && ws.code) {
      const share = shares.get(ws.code);
      if (share && share.senderId === ws.peerId) {
        for (const rid of share.receiverIds) {
          wsSend(peers.get(rid), { type: 'error', message: 'Sender disconnected' });
        }
        shares.delete(ws.code);
      }
    }

    if (ws.role === 'receiver' && ws.code) {
      const share = shares.get(ws.code);
      if (share) share.receiverIds.delete(ws.peerId);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LAN Share P2P running on port ${PORT}`);
});
