import {
  generateClientId,
  encryptMessage,
  decryptMessage,
  logEvent,
  isString,
  isObject,
  getTime
} from './utils.js';

/**
 * Default worker entry: route HTTP requests and WebSocket upgrades to the Durable Object stub.
 * 保持 export default 以便 Cloudflare Worker 正确路由到 Durable Object。
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 处理 WebSocket Upgrade 请求（由 Durable Object 处理）
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      const id = env.CHAT_ROOM.idFromName('chat-room');
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // 处理 API 请求（占位）
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 其他交由 ASSETS（静态文件 / SPA fallback）
    return env.ASSETS.fetch(request);
  }
};

/**
 * ChatRoom Durable Object
 * - 支持两种模式：'e2ee'（默认，使用 ECDH + RSA 签名），'standard'（标准明文）
 * - 已修复并强化了私钥恢复、客户端公钥校验、以及 standard/e2ee 消息路径差异
 */
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // 使用 plain object 存客户端和频道，便于序列化和调试
    this.clients = {};
    this.channels = {};

    this.config = {
      seenTimeout: 60000,
      debug: false
    };

    this.keyPair = null;

    // 初始化 RSA 密钥对（异步）
    this.initRSAKeyPair().catch(err => {
      console.error('initRSAKeyPair failed at constructor:', err);
    });
  }

  // ---------- Helper: simple hex validator ----------
  isHexString(str) {
    return typeof str === 'string' && /^[0-9a-fA-F]+$/.test(str) && (str.length % 2 === 0);
  }

  // ---------- Initialize RSA key pair: read or generate ----------
  async initRSAKeyPair() {
    try {
      let stored = await this.state.storage.get('rsaKeyPair');

      if (!stored) {
        console.log('Generating new RSA keypair...');
        const keyPair = await crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256'
          },
          true,
          ['sign', 'verify']
        );

        const [publicKeyBuffer, privateKeyBuffer] = await Promise.all([
          crypto.subtle.exportKey('spki', keyPair.publicKey),
          crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
        ]);

        stored = {
          rsaPublic: btoa(String.fromCharCode(...new Uint8Array(publicKeyBuffer))),
          // 保存为 number[] 以便序列化到 Durable Object Storage（JSON）
          rsaPrivateData: Array.from(new Uint8Array(privateKeyBuffer)),
          createdAt: Date.now()
        };

        await this.state.storage.put('rsaKeyPair', stored);
        console.log('RSA key pair generated and stored');
      }

      // 验证数据结构
      if (!stored.rsaPrivateData || !Array.isArray(stored.rsaPrivateData)) {
        throw new Error('Stored rsaPrivateData is missing or invalid');
      }

      // 将存储的 number[] 转回 ArrayBuffer 导入为 CryptoKey
      const privateKeyBuffer = (new Uint8Array(stored.rsaPrivateData)).buffer;

      stored.rsaPrivate = await crypto.subtle.importKey(
        'pkcs8',
        privateKeyBuffer,
        {
          name: 'RSASSA-PKCS1-v1_5',
          hash: 'SHA-256'
        },
        false,
        ['sign']
      );

      // 将 rsaPublic 保持为 base64 字符串（客户端需要此字符串）
      this.keyPair = stored;

      // 检查是否需要轮换（超过 24 小时）
      if (stored.createdAt && (Date.now() - stored.createdAt > 24 * 60 * 60 * 1000)) {
        if (Object.keys(this.clients).length === 0) {
          console.log('Key older than 24h and no active clients -> rotate now');
          await this.state.storage.delete('rsaKeyPair');
          this.keyPair = null;
          await this.initRSAKeyPair();
        } else {
          // 标记 pending rotation（等待客户端断开）
          await this.state.storage.put('pendingKeyRotation', true);
        }
      }
    } catch (error) {
      console.error('Error initializing RSA key pair:', error);
      throw error;
    }
  }

  // ---------- Durable Object fetch: handle WebSocket upgrade ----------
  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket Upgrade', { status: 426 });
    }

    // 解析 URL 参数（room, user, pwdHash, mode）
    const url = new URL(request.url);
    const room = url.searchParams.get('room') || '';
    const user = url.searchParams.get('user') || '';
    const pwdHash = url.searchParams.get('pwdHash') || '';
    const mode = url.searchParams.get('mode') || 'e2ee'; // 'e2ee' 或 'standard'

    // 确保 RSA keys 已初始化（E2EE 需要）
    if (!this.keyPair) {
      await this.initRSAKeyPair();
    }

    const webSocketPair = new WebSocketPair();
    const [clientSide, serverSide] = Object.values(webSocketPair);

    // 将 server side socket 交给 handleSession，并传递解析后的参数
    this.handleSession(serverSide, { room, user, pwdHash, mode });

    return new Response(null, {
      status: 101,
      webSocket: clientSide
    });
  }

  // ---------- Accept a new session (WebSocket server side) ----------
  async handleSession(connection, params) {
    connection.accept();

    // 清理旧连接
    await this.cleanupOldConnections();

    const clientId = generateClientId();

    if (!clientId || this.clients[clientId]) {
      this.closeConnection(connection);
      return;
    }

    logEvent('connection', clientId, 'debug');

    // 存储客户端基础信息
    this.clients[clientId] = {
      connection,
      seen: getTime(),
      key: null,
      shared: null,
      channel: null,
      room: params.room,
      user: params.user,
      pwdHash: params.pwdHash,
      mode: params.mode // 'e2ee' | 'standard'
    };

    // 如果是 standard 模式：跳过 E2EE 握手，生成一个占位 shared key，仅用于内部逻辑一致性
    if (params.mode === 'standard') {
      logEvent('mode-standard', clientId, 'debug');

      // 占位 shared（仅内部使用），但发送/接收消息时按明文 JSON 处理
      this.clients[clientId].shared = new Uint8Array(32);

      // 直接将客户端加入频道（调用 handleJoinChannel）
      this.handleJoinChannel(clientId, { p: this.clients[clientId].room });

      // 监听消息：标准模式下期望明文 JSON 字符串
      connection.addEventListener('message', async (event) => {
        const message = event.data;
        this.clients[clientId].seen = getTime();

        if (!isString(message)) return;
        if (message === 'ping') {
          this.sendMessage(connection, 'pong');
          return;
        }

        // 标准模式下直接作为明文处理
        this.processEncryptedMessage(clientId, message);
      });

      connection.addEventListener('close', async (ev) => {
        await this.onConnectionClose(clientId, ev);
      });

      return; // standard 处理完毕
    }

    // E2EE 模式：向客户端发送服务器 RSA 公钥（base64）
    try {
      logEvent('sending-public-key', clientId, 'debug');
      this.sendMessage(connection, JSON.stringify({
        type: 'server-key',
        key: this.keyPair.rsaPublic
      }));
    } catch (error) {
      logEvent('sending-public-key', error, 'error');
    }

    // 继续监听消息（E2EE 模式下先进行 ECDH 握手）
    connection.addEventListener('message', async (event) => {
      const message = event.data;

      if (!isString(message) || !this.clients[clientId]) {
        return;
      }

      this.clients[clientId].seen = getTime();

      if (message === 'ping') {
        this.sendMessage(connection, 'pong');
        return;
      }

      logEvent('message', [clientId, message], 'debug');

      // E2EE: 当 shared 未建立且消息长度较短时，视作客户端发送的 public key (hex)
      if (!this.clients[clientId].shared && message.length < 4096) {
        // 先校验 hex 字符串
        const clientPublicKeyHex = message;
        if (!this.isHexString(clientPublicKeyHex)) {
          logEvent('invalid-client-pubkey', [clientId, clientPublicKeyHex], 'error');
          this.closeConnection(connection);
          return;
        }

        try {
          // Generate ECDH key pair using P-384 curve
          const keys = await crypto.subtle.generateKey(
            {
              name: 'ECDH',
              namedCurve: 'P-384'
            },
            true,
            ['deriveBits', 'deriveKey']
          );

          const publicKeyBuffer = await crypto.subtle.exportKey('raw', keys.publicKey);

          // Sign the public key using RSA private key
          const signature = await crypto.subtle.sign(
            {
              name: 'RSASSA-PKCS1-v1_5'
            },
            this.keyPair.rsaPrivate,
            publicKeyBuffer
          );

          // Convert client hex to bytes and import
          const clientPublicKeyBytes = new Uint8Array(clientPublicKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
          const clientPublicKey = await crypto.subtle.importKey(
            'raw',
            clientPublicKeyBytes.buffer,
            { name: 'ECDH', namedCurve: 'P-384' },
            false,
            []
          );

          // Derive shared secret bits (384 bits -> 48 bytes)
          const sharedSecretBits = await crypto.subtle.deriveBits(
            {
              name: 'ECDH',
              public: clientPublicKey
            },
            keys.privateKey,
            384
          );

          // Take bytes 8-40 (32 bytes) as AES-256 key material
          this.clients[clientId].shared = new Uint8Array(sharedSecretBits).slice(8, 40);

          const response = Array.from(new Uint8Array(publicKeyBuffer))
            .map(b => b.toString(16).padStart(2, '0')).join('') + '|' +
            btoa(String.fromCharCode(...new Uint8Array(signature)));

          this.sendMessage(connection, response);
        } catch (error) {
          logEvent('message-key', [clientId, error], 'error');
          this.closeConnection(connection);
        }

        return;
      }

      // 否则视为加密消息，交由统一处理（若解密失败会被忽略）
      if (this.clients[clientId].shared && message.length <= (8 * 1024 * 1024)) {
        this.processEncryptedMessage(clientId, message);
      }
    });

    connection.addEventListener('close', async (event) => {
      await this.onConnectionClose(clientId, event);
    });
  }

  // ---------- Common connection close handler ----------
  async onConnectionClose(clientId, event) {
    logEvent('close', [clientId, event], 'debug');

    const channel = this.clients[clientId] && this.clients[clientId].channel;

    if (channel && this.channels[channel]) {
      const idx = this.channels[channel].indexOf(clientId);
      if (idx >= 0) this.channels[channel].splice(idx, 1);

      if (this.channels[channel].length === 0) {
        delete this.channels[channel];
      } else {
        // 广播新的成员列表给频道内成员（区分 standard/e2ee）
        try {
          const members = this.channels[channel];
          for (const member of members) {
            const client = this.clients[member];
            if (this.isClientInChannel(client, channel)) {
              const messageObj = {
                a: 'l',
                p: members.filter(v => v !== member)
              };
              this.sendToClient(member, messageObj);
            }
          }
        } catch (error) {
          logEvent('close-list', [clientId, error], 'error');
        }
      }
    }

    if (this.clients[clientId]) {
      try {
        this.clients[clientId].connection.close();
      } catch (e) {
        // ignore
      }
      delete this.clients[clientId];
    }
  }

  // ---------- Process encrypted or plain messages (统一入口) ----------
  processEncryptedMessage(clientId, message) {
    let decrypted = null;
    const client = this.clients[clientId];

    if (!client) return;

    // Standard: parse plain JSON
    if (client.mode === 'standard') {
      try {
        if (!isString(message)) return;
        decrypted = JSON.parse(message);
        logEvent('message-plain-parsed', [clientId, decrypted], 'debug');
      } catch (error) {
        logEvent('message-plain-parse-error', [clientId, error], 'error');
        return;
      }
    } else {
      // E2EE: 解密
      try {
        decrypted = decryptMessage(message, client.shared);
        logEvent('message-decrypted', [clientId, decrypted], 'debug');
      } catch (error) {
        logEvent('message-decrypt-error', [clientId, error], 'error');
        return;
      }
    }

    try {
      if (!isObject(decrypted) || !isString(decrypted.a)) {
        return;
      }

      const action = decrypted.a;

      if (action === 'j') {
        // 在 standard 模式下，客户端通常不会发送 'j'（我们已在连接阶段处理）
        this.handleJoinChannel(clientId, decrypted);
      } else if (action === 'c') {
        this.handleClientMessage(clientId, decrypted);
      } else if (action === 'w') {
        this.handleChannelMessage(clientId, decrypted);
      }
    } catch (error) {
      logEvent('process-message-action', [clientId, error], 'error');
    } finally {
      decrypted = null;
    }
  }

  // ---------- Join channel ----------
  handleJoinChannel(clientId, decrypted) {
    if (!isString(decrypted.p) || this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = decrypted.p;
      this.clients[clientId].channel = channel;

      if (!this.channels[channel]) {
        this.channels[channel] = [clientId];
      } else {
        this.channels[channel].push(clientId);
      }

      // 广播成员列表
      this.broadcastMemberList(channel);
    } catch (error) {
      logEvent('message-join', [clientId, error], 'error');
    }
  }

  // ---------- Send client-to-client (direct) message ----------
  handleClientMessage(clientId, decrypted) {
    if (!isString(decrypted.p) || !isString(decrypted.c) || !this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = this.clients[clientId].channel;
      const targetClient = this.clients[decrypted.c];

      if (this.isClientInChannel(targetClient, channel)) {
        const messageObj = {
          a: 'c',
          p: decrypted.p,
          c: clientId
        };

        // 发送给目标客户端（自动区分 standard/e2ee）
        this.sendToClient(decrypted.c, messageObj);

        // 清理敏感字段
        messageObj.p = null;
      }
    } catch (error) {
      logEvent('message-client', [clientId, error], 'error');
    }
  }

  // ---------- Broadcast to multiple members (channel message) ----------
  handleChannelMessage(clientId, decrypted) {
    if (!isObject(decrypted.p) || !this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = this.clients[clientId].channel;

      const validMembers = Object.keys(decrypted.p).filter(member => {
        const targetClient = this.clients[member];
        return isString(decrypted.p[member]) && this.isClientInChannel(targetClient, channel);
      });

      for (const member of validMembers) {
        const targetClient = this.clients[member];
        const messageObj = {
          a: 'c',
          p: decrypted.p[member],
          c: clientId
        };
        this.sendToClient(member, messageObj);
        messageObj.p = null;
      }
    } catch (error) {
      logEvent('message-channel', [clientId, error], 'error');
    }
  }

  // ---------- Broadcast member list ----------
  broadcastMemberList(channel) {
    try {
      const members = this.channels[channel] || [];

      for (const member of members) {
        const client = this.clients[member];
        if (this.isClientInChannel(client, channel)) {
          const messageObj = {
            a: 'l',
            p: members.filter(v => v !== member)
          };
          this.sendToClient(member, messageObj);
        }
      }
    } catch (error) {
      logEvent('broadcast-member-list', error, 'error');
    }
  }

  // ---------- Determine if client is active in channel ----------
  isClientInChannel(client, channel) {
    return !!(client && client.connection && client.shared && client.channel === channel);
  }

  // ---------- Send helper: 自动区分 standard / e2ee ----------
  sendToClient(clientId, messageObj) {
    const target = this.clients[clientId];
    if (!target || !target.connection) return;

    try {
      if (target.mode === 'standard') {
        // 明文 JSON
        this.sendMessage(target.connection, JSON.stringify(messageObj));
      } else {
        // E2EE：加密并发送
        const encrypted = encryptMessage(messageObj, target.shared);
        this.sendMessage(target.connection, encrypted);
      }
    } catch (error) {
      logEvent('sendToClient', [clientId, error], 'error');
    }
  }

  // ---------- Send message primitive ----------
  sendMessage(connection, message) {
    try {
      if (connection && connection.readyState === 1) {
        connection.send(message);
      }
    } catch (error) {
      logEvent('sendMessage', error, 'error');
    }
  }

  // ---------- Close connection primitive ----------
  closeConnection(connection) {
    try {
      if (connection) connection.close();
    } catch (error) {
      logEvent('closeConnection', error, 'error');
    }
  }

  // ---------- Cleanup stale connections ----------
  async cleanupOldConnections() {
    const seenThreshold = getTime() - this.config.seenTimeout;
    const clientsToRemove = [];

    for (const clientId in this.clients) {
      if (this.clients[clientId].seen < seenThreshold) {
        clientsToRemove.push(clientId);
      }
    }

    for (const clientId of clientsToRemove) {
      try {
        logEvent('connection-seen', clientId, 'debug');
        const conn = this.clients[clientId].connection;
        if (conn) conn.close();
        delete this.clients[clientId];
      } catch (error) {
        logEvent('connection-seen', error, 'error');
      }
    }

    // 如果没有活动客户端或频道，检查是否有 pendingKeyRotation
    if (Object.keys(this.clients).length === 0 && Object.keys(this.channels).length === 0) {
      const pendingRotation = await this.state.storage.get('pendingKeyRotation');
      if (pendingRotation) {
        console.log('No active clients/rooms -> performing pending key rotation...');
        await this.state.storage.delete('rsaKeyPair');
        await this.state.storage.delete('pendingKeyRotation');
        this.keyPair = null;
        await this.initRSAKeyPair();
      }
    }

    return clientsToRemove.length;
  }
}
