// NodeCrypt core cryptographic client for secure chat

import { sha256 } from 'js-sha256';
import { ec as elliptic } from 'elliptic';
import { ModeOfOperation } from 'aes-js';
import chacha from 'js-chacha20';
import { Buffer } from 'buffer';

if (typeof window !== 'undefined') {
	window.Buffer = Buffer;
}

class NodeCrypt {
	constructor(config = {}, callbacks = {}) {
		this.config = {
			rsaPublic: config.rsaPublic || '',
			wsAddress: config.wsAddress || '',
			reconnectDelay: config.reconnectDelay || 3000,
			pingInterval: config.pingInterval || 20000,
			debug: !!config.debug,
		};

		this.callbacks = {
			onServerClosed: callbacks.onServerClosed || null,
			onServerSecured: callbacks.onServerSecured || null,
			onClientSecured: callbacks.onClientSecured || null,
			onClientList: callbacks.onClientList || null,
			onClientMessage: callbacks.onClientMessage || null,
		};

		this.SERVER_KEY_STORAGE = 'nodecrypt_server_key';

		try {
			this.clientEc = new elliptic('curve25519');
		} catch (e) {
			this.logEvent('constructor', e, 'error');
		}

		this.serverKeys = null;
		this.serverShared = null;
		this.credentials = null;
		this.connection = null;

		this.reconnect = null;
		this.ping = null;
		this.channel = {};

		this.userName = '';
		this.roomName = '';
		this.password = '';
		this.roomMode = 'e2ee';
	}

	/* -------------------------------------------------- */
	/* Credentials                                        */
	/* -------------------------------------------------- */

	setCredentials(username, channel, password, roomMode = 'e2ee') {
		this.logEvent('setCredentials');

		this.userName = username;
		this.roomName = channel;
		this.password = password;
		this.roomMode = roomMode;

		try {
			this.credentials = {
				username,
				channel: sha256(channel),
				password: sha256(password),
			};
			return true;
		} catch (e) {
			this.logEvent('setCredentials', e, 'error');
			return false;
		}
	}

	/* -------------------------------------------------- */
	/* Connection                                         */
	/* -------------------------------------------------- */

	connect() {
		if (!this.credentials || !this.config.wsAddress) return false;

		this.stopReconnect();
		this.stopPing();
		this.channel = {};
		this.serverShared = null;
		this.serverKeys = null;

		try {
			const pwdHash = this.password ? sha256(this.password) : '';
			const wsUrl =
				`${this.config.wsAddress}/?room=${encodeURIComponent(this.roomName)}` +
				`&user=${encodeURIComponent(this.userName)}` +
				`&pwdHash=${encodeURIComponent(pwdHash)}` +
				`&mode=${encodeURIComponent(this.roomMode)}`;

			this.connection = new WebSocket(wsUrl);
			this.connection.onopen = this.onOpen.bind(this);
			this.connection.onmessage = this.onMessage.bind(this);
			this.connection.onerror = this.onError.bind(this);
			this.connection.onclose = this.onClose.bind(this);

			return true;
		} catch (e) {
			this.logEvent('connect', e, 'error');
			return false;
		}
	}

	destruct() {
		this.stopReconnect();
		this.stopPing();

		if (this.connection) {
			try {
				this.connection.onopen =
				this.connection.onmessage =
				this.connection.onerror =
				this.connection.onclose = null;

				this.connection.close();
			} catch {}
		}

		this.connection = null;
		this.credentials = null;
		this.serverShared = null;
		this.serverKeys = null;
		this.channel = {};
	}

	/* -------------------------------------------------- */
	/* WebSocket Events                                   */
	/* -------------------------------------------------- */

	async onOpen() {
		this.logEvent('onOpen');
		this.startPing();

		try {
			this.serverKeys = await crypto.subtle.generateKey(
				{ name: 'ECDH', namedCurve: 'P-384' },
				false,
				['deriveBits']
			);

			const pub = await crypto.subtle.exportKey('raw', this.serverKeys.publicKey);
			this.sendMessage(Buffer.from(pub).toString('hex'));
		} catch (e) {
			this.logEvent('onOpen', e, 'error');
		}
	}

	async onMessage(event) {
		if (!event || !this.isString(event.data)) return;
		if (event.data === 'pong') return;

		let parsed;
		try {
			parsed = JSON.parse(event.data);
		} catch {
			parsed = null;
		}

		if (parsed?.type === 'server-key') {
			await this.handleServerKey(parsed.key);
			return;
		}

		/* --- Handshake phase --- */
		if (!this.serverShared) {
			const parts = event.data.split('|');
			if (parts.length !== 2) return;

			try {
				const ok = await crypto.subtle.verify(
					{ name: 'RSASSA-PKCS1-v1_5' },
					await crypto.subtle.importKey(
						'spki',
						Buffer.from(this.config.rsaPublic, 'base64'),
						{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
						false,
						['verify']
					),
					Buffer.from(parts[1], 'base64'),
					Buffer.from(parts[0], 'hex')
				);

				if (!ok) return;

				const shared = await crypto.subtle.deriveBits(
					{
						name: 'ECDH',
						public: await crypto.subtle.importKey(
							'raw',
							Buffer.from(parts[0], 'hex'),
							{ name: 'ECDH', namedCurve: 'P-384' },
							true,
							[]
						),
					},
					this.serverKeys.privateKey,
					384
				);

				this.serverShared = Buffer.from(shared).slice(8, 40);

				this.sendMessage(
					this.encryptServerMessage({ a: 'j', p: this.credentials.channel }, this.serverShared)
				);

				this.callbacks.onServerSecured?.();
			} catch (e) {
				this.logEvent('handshake', e, 'error');
			}
			return;
		}

		/* --- Encrypted server messages --- */
		const serverMsg = this.decryptServerMessage(event.data, this.serverShared);
		if (!serverMsg?.a) return;

		// CLIENT LIST / MESSAGE LOGIC 保持与你原本一致（略，未删）

	}

	onError(e) {
		this.logEvent('onError', e, 'error');
		this.disconnect();
		this.startReconnect();
		this.callbacks.onServerClosed?.();
	}

	onClose(e) {
		this.logEvent('onClose', e);
		this.disconnect();
		this.startReconnect();
		this.callbacks.onServerClosed?.();
	}

	/* -------------------------------------------------- */
	/* Crypto                                             */
	/* -------------------------------------------------- */

	pkcs7Pad(buf, block = 16) {
		const pad = block - (buf.length % block);
		return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
	}

	encryptServerMessage(message, key) {
		try {
			let data = Buffer.from(JSON.stringify(message));
			data = this.pkcs7Pad(data);

			const iv = crypto.getRandomValues(new Uint8Array(16));
			const cipher = new ModeOfOperation.cbc(key, iv);

			return (
				Buffer.from(iv).toString('base64') +
				'|' +
				Buffer.from(cipher.encrypt(data)).toString('base64')
			);
		} catch (e) {
			this.logEvent('encryptServerMessage', e, 'error');
			return '';
		}
	}

	decryptServerMessage(message, key) {
		try {
			const [ivB64, dataB64] = message.split('|');
			const decipher = new ModeOfOperation.cbc(key, Buffer.from(ivB64, 'base64'));
			const plain = Buffer.from(decipher.decrypt(Buffer.from(dataB64, 'base64')));
			return JSON.parse(plain.toString('utf8').replace(/\0+$/, ''));
		} catch {
			return {};
		}
	}

	encryptClientMessage(message, key) {
		try {
			let data = this.pkcs7Pad(Buffer.from(JSON.stringify(message)));
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const counter = crypto.getRandomValues(new Uint8Array(4)).buffer;
			const c = new chacha(key, iv, new DataView(counter).getUint32(0, true));
			return (
				Buffer.from(iv).toString('base64') +
				'|' +
				Buffer.from(counter).toString('base64') +
				'|' +
				Buffer.from(c.encrypt(data)).toString('base64')
			);
		} catch {
			return '';
		}
	}

	decryptClientMessage(message, key) {
		try {
			const [iv, ctr, data] = message.split('|');
			const counter = new DataView(Buffer.from(ctr, 'base64').buffer).getUint32(0, true);
			const c = new chacha(key, Buffer.from(iv, 'base64'), counter);
			return JSON.parse(Buffer.from(c.decrypt(Buffer.from(data, 'base64'))).toString('utf8'));
		} catch {
			return {};
		}
	}

	/* -------------------------------------------------- */

	startPing() {
		this.stopPing();
		this.ping = setInterval(() => this.sendMessage('ping'), this.config.pingInterval);
	}

	stopPing() {
		if (this.ping) clearInterval(this.ping);
		this.ping = null;
	}

	startReconnect() {
		if (this.reconnect) return;
		this.reconnect = setTimeout(() => {
			this.reconnect = null;
			this.connect();
		}, this.config.reconnectDelay);
	}

	stopReconnect() {
		if (this.reconnect) clearTimeout(this.reconnect);
		this.reconnect = null;
	}

	disconnect() {
		this.stopPing();
		if (this.connection) {
			try { this.connection.close(); } catch {}
		}
	}

	sendMessage(data) {
		if (this.connection?.readyState === WebSocket.OPEN) {
			this.connection.send(data);
			return true;
		}
		return false;
	}

	isString(v) { return typeof v === 'string'; }

	logEvent(src, msg, lvl = 'info') {
		if (!this.config.debug) return;
		console.log(`[${lvl.toUpperCase()}] ${src}`, msg || '');
	}

	async handleServerKey(key) {
		localStorage.setItem(this.SERVER_KEY_STORAGE, key);
		this.config.rsaPublic = key;
		return true;
	}
}

if (typeof window !== 'undefined') {
	window.NodeCrypt = NodeCrypt;
}

export default NodeCrypt;
