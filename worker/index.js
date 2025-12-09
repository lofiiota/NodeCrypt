import {
  generateClientId,
  encryptMessage,
  decryptMessage,
  logEvent,
  isString,
  isObject,
  getTime
} from './utils.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 处理 WebSocket 请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      const id = env.CHAT_ROOM.idFromName('chat-room');
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // 处理 API 请求
    if (url.pathname.startsWith('/api/')) {
      // ...API 逻辑...
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 其余全部交给 ASSETS 处理（自动支持 hash 文件名和 SPA fallback）
    return env.ASSETS.fetch(request);
  }
};

export class ChatRoom {
  constructor(state, env) {
    this.state = state;

    // Use plain objects rather than Maps for serialization-friendliness in Durable Objects
    this.clients = {};
    this.channels = {};

    this.config = {
      seenTimeout: 60000,
      debug: false
    };

    this.keyPair = null;

    // Initialize RSA key pair (async, but start here)
    // Note: callers should await initRSAKeyPair if they depend on keys being ready.
    this.initRSAKeyPair().catch(err => {
      console.error('initRSAKeyPair error (constructor):', err);
    });
  }

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

        // 并行导出公钥和私钥以提高性能
        const [publicKeyBuffer, privateKeyBuffer] = await Promise.all([
          crypto.subtle.exportKey('spki', keyPair.publicKey),
          crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
        ]);

        stored = {
          rsaPublic: btoa(String.fromCharCode(...new Uint8Array(publicKeyBuffer))),
          // 持久化使用 Array<number> 便于 Durable Object storage
          rsaPrivateData: Array.from(new Uint8Array(privateKeyBuffer)),
          createdAt: Date.now() // 记录密钥创建时间，用于后续判断是否需要轮换
        };

        await this.state.storage.put('rsaKeyPair', stored);
        console.log('RSA key pair generated and stored');
      }

      // Reconstruct the private key if stored.rsaPrivateData 存在
      if (stored.rsaPrivateData) {
        const privateKeyBuffer = new Uint8Array(stored.rsaPrivateData).buffer;

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
      }

      this.keyPair = stored;

      // 检查密钥是否需要轮换（如果已创建超过24小时）
      if (stored.createdAt && (Date.now() - stored.createdAt > 24 * 60 * 60 * 1000)) {
        // 如果没有任何客户端，则执行密钥轮换
        if (Object.keys(this.clients).length === 0) {
          console.log('密钥已使用24小时，进行轮换...');
          await this.state.storage.delete('rsaKeyPair');
          this.keyPair = null;
          await this.initRSAKeyPair();
        } else {
          // 否则标记需要在客户端全部断开后进行轮换
          await this.state.storage.put('pendingKeyRotation', true);
        }
      }
    } catch (error) {
      console.error('Error initializing RSA key pair:', error);
      throw error;
    }
  }

  async fetch(request) {
    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket Upgrade', { status: 426 });
    }

    // Ensure RSA keys are initialized
    if (!this.keyPair) {
      await this.initRSAKeyPair();
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Accept the WebSocket connection on server (Durable Object side)
    this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  // WebSocket connection event handler
  async handleSession(connection) {
    // Accept the connection
    connection.accept();

    // 清理旧连接
    await this.cleanupOldConnections();

    const clientId = generateClientId();

    if (!clientId || this.clients[clientId]) {
      this.closeConnection(connection);
      return;
    }

    logEvent('connection', clientId, 'debug');

    // Store client information
    this.clients[clientId] = {
      connection: connection,
      seen: getTime(),
      key: null,
      shared: null,
      channel: null
    };

    // Send RSA public key
    try {
      logEvent('sending-public-key', clientId, 'debug');
      this.sendMessage(
        connection,
        JSON.stringify({
          type: 'server-key',
          key: this.keyPair.rsaPublic
        })
      );
    } catch (error) {
      logEvent('sending-public-key', error, 'error');
    }

    // Handle messages
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

      // Handle key exchange
      if (!this.clients[clientId].shared && message.length < 2048) {
        try {
          // Generate ECDH key pair using P-384 curve (equivalent to secp384r1)
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

          // Convert hex string to Uint8Array for client public key
          const clientPublicKeyHex = message;
          const clientPublicKeyBytes = new Uint8Array(
            clientPublicKeyHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
          );

          // Import client's public key
          const clientPublicKey = await crypto.subtle.importKey(
            'raw',
            clientPublicKeyBytes.buffer,
            { name: 'ECDH', namedCurve: 'P-384' },
            false,
            []
          );

          // Derive shared secret bits (equivalent to computeSecret in Node.js)
          const sharedSecretBits = await crypto.subtle.deriveBits(
            {
              name: 'ECDH',
              public: clientPublicKey
            },
            keys.privateKey,
            384 // P-384 produces 48 bytes (384 bits)
          );

          // Take bytes 8-40 (32 bytes) for AES-256 key
          this.clients[clientId].shared = new Uint8Array(sharedSecretBits).slice(8, 40);

          const response =
            Array.from(new Uint8Array(publicKeyBuffer))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('') +
            '|' +
            btoa(String.fromCharCode(...new Uint8Array(signature)));

          this.sendMessage(connection, response);
        } catch (error) {
          logEvent('message-key', [clientId, error], 'error');
          this.closeConnection(connection);
        }

        return;
      }

      // Handle encrypted messages
      if (this.clients[clientId].shared && message.length <= 8 * 1024 * 1024) {
        this.processEncryptedMessage(clientId, message);
      }
    });

    // Handle connection close
    connection.addEventListener('close', async (event) => {
      logEvent('close', [clientId, event], 'debug');

      const channel = this.clients[clientId] ? this.clients[clientId].channel : null;

      if (channel && this.channels[channel]) {
        const idx = this.channels[channel].indexOf(clientId);
        if (idx !== -1) {
          this.channels[channel].splice(idx, 1);
        }

        if (this.channels[channel].length === 0) {
          delete this.channels[channel];
        } else {
          try {
            const members = this.channels[channel];

            for (const member of members) {
              const client = this.clients[member];
              if (this.isClientInChannel(client, channel)) {
                this.sendMessage(
                  client.connection,
                  encryptMessage(
                    {
                      a: 'l',
                      p: members.filter((value) => value !== member)
                    },
                    client.shared
                  )
                );
              }
            }
          } catch (error) {
            logEvent('close-list', [clientId, error], 'error');
          }
        }
      }

      if (this.clients[clientId]) {
        delete this.clients[clientId];
      }
    });
  }

  // Process encrypted messages
  processEncryptedMessage(clientId, message) {
    let decrypted = null;

    try {
      decrypted = decryptMessage(message, this.clients[clientId].shared);

      logEvent('message-decrypted', [clientId, decrypted], 'debug');

      if (!isObject(decrypted) || !isString(decrypted.a)) {
        return;
      }

      const action = decrypted.a;

      if (action === 'j') {
        this.handleJoinChannel(clientId, decrypted);
      } else if (action === 'c') {
        this.handleClientMessage(clientId, decrypted);
      } else if (action === 'w') {
        this.handleChannelMessage(clientId, decrypted);
      }
    } catch (error) {
      logEvent('process-encrypted-message', [clientId, error], 'error');
    } finally {
      decrypted = null;
    }
  }

  // Handle channel join requests
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

      this.broadcastMemberList(channel);
    } catch (error) {
      logEvent('message-join', [clientId, error], 'error');
    }
  }

  // Handle client messages (private message to a specific client)
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

        const encrypted = encryptMessage(messageObj, targetClient.shared);
        this.sendMessage(targetClient.connection, encrypted);

        // Clear sensitive payload
        messageObj.p = null;
      }
    } catch (error) {
      logEvent('message-client', [clientId, error], 'error');
    }
  }

  // Handle channel messages (broadcast to specific members in channel)
  handleChannelMessage(clientId, decrypted) {
    if (!isObject(decrypted.p) || !this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = this.clients[clientId].channel;

      // 过滤有效的目标成员
      const validMembers = Object.keys(decrypted.p).filter((member) => {
        const targetClient = this.clients[member];
        return isString(decrypted.p[member]) && this.isClientInChannel(targetClient, channel);
      });

      // 处理所有有效的目标成员
      for (const member of validMembers) {
        const targetClient = this.clients[member];
        const messageObj = {
          a: 'c',
          p: decrypted.p[member],
          c: clientId
        };

        const encrypted = encryptMessage(messageObj, targetClient.shared);
        this.sendMessage(targetClient.connection, encrypted);

        messageObj.p = null;
      }
    } catch (error) {
      logEvent('message-channel', [clientId, error], 'error');
    }
  }

  // Broadcast member list to channel
  broadcastMemberList(channel) {
    try {
      const members = this.channels[channel];

      for (const member of members) {
        const client = this.clients[member];

        if (this.isClientInChannel(client, channel)) {
          const messageObj = {
            a: 'l',
            p: members.filter((value) => value !== member)
          };

          const encrypted = encryptMessage(messageObj, client.shared);
          this.sendMessage(client.connection, encrypted);

          messageObj.p = null;
        }
      }
    } catch (error) {
      logEvent('broadcast-member-list', error, 'error');
    }
  }

  // Check if client is in channel
  isClientInChannel(client, channel) {
    return !!(
      client &&
      client.connection &&
      client.shared &&
      client.channel === channel
    );
  }

  // Send message helper
  sendMessage(connection, message) {
    try {
      // In Cloudflare Workers, WebSocket.OPEN is 1
      if (connection && connection.readyState === 1) {
        connection.send(message);
      }
    } catch (error) {
      logEvent('sendMessage', error, 'error');
    }
  }

  // Close connection helper
  closeConnection(connection) {
    try {
      if (connection) {
        connection.close();
      }
    } catch (error) {
      logEvent('closeConnection', error, 'error');
    }
  }

  // 连接清理方法
  async cleanupOldConnections() {
    const seenThreshold = getTime() - this.config.seenTimeout;
    const clientsToRemove = [];

    // 先收集需要移除的客户端，避免在迭代时修改对象
    for (const clientId in this.clients) {
      if (this.clients[clientId].seen < seenThreshold) {
        clientsToRemove.push(clientId);
      }
    }

    // 然后一次性移除所有过期客户端
    for (const clientId of clientsToRemove) {
      try {
        logEvent('connection-seen', clientId, 'debug');
        if (this.clients[clientId] && this.clients[clientId].connection) {
          this.clients[clientId].connection.close();
        }
        delete this.clients[clientId];
      } catch (error) {
        logEvent('connection-seen', error, 'error');
      }
    }

    // 如果没有任何客户端和房间，检查是否需要轮换密钥
    if (Object.keys(this.clients).length === 0 && Object.keys(this.channels).length === 0) {
      const pendingRotation = await this.state.storage.get('pendingKeyRotation');
      if (pendingRotation) {
        console.log('没有活跃客户端或房间，执行密钥轮换...');
        await this.state.storage.delete('rsaKeyPair');
        await this.state.storage.delete('pendingKeyRotation');
        this.keyPair = null;
        await this.initRSAKeyPair();
      }
    }

    return clientsToRemove.length; // 返回清理的连接数量
  }
}
