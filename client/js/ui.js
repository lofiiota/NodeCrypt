// UI logic for NodeCrypt web client
// NodeCrypt 网页客户端的 UI 逻辑

import { createAvatarSVG } from './util.avatar.js';
import { roomsData, activeRoomIndex, togglePrivateChat, exitRoom } from './room.js';
import { escapeHTML } from './util.string.js';
import { $id } from './util.dom.js';
import { closeSettingsPanel } from './util.settings.js';
import { t } from './util.i18n.js';
import { updateChatInputStyle } from './chat.js';

// ---------------------- Utilities ----------------------

// Safe UTF-8 <-> Base64 helpers (avoid deprecated escape/unescape)
function utf8ToBase64(str) {
	if (typeof str !== 'string') return '';
	const bytes = new TextEncoder().encode(str);
	let binary = '';
	// convert to binary string for btoa
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}
function base64ToUtf8(b64) {
	if (typeof b64 !== 'string' || b64 === '') return '';
	try {
		const binary = atob(b64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return new TextDecoder().decode(bytes);
	} catch (e) {
		console.warn('base64ToUtf8 decode error', e);
		return '';
	}
}

// Simple encryption/decryption using base64 + shifting (kept for backward compat)
// Note: not cryptographically secure. Used only for share link obfuscation.
function simpleEncrypt(text) {
	if (!text) return '';
	const base64 = utf8ToBase64(text);
	return base64.split('').map(ch => String.fromCharCode(ch.charCodeAt(0) + 3)).join('');
}
function simpleDecrypt(encrypted) {
	if (!encrypted) return '';
	try {
		const shifted = encrypted.split('').map(ch => String.fromCharCode(ch.charCodeAt(0) - 3)).join('');
		return base64ToUtf8(shifted);
	} catch (error) {
		console.warn('Failed to decrypt data:', error);
		return '';
	}
}

// clipboard helper with fallback
function copyToClipboard(text, successMessage = t('action.copied', 'Copied to clipboard!'), errorPrefix = t('action.copy_failed', 'Copy failed, url:')) {
	if (!text) {
		window.addSystemMsg && window.addSystemMsg(t('action.nothing_to_copy', 'Nothing to copy'));
		return;
	}

	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard.writeText(text).then(() => {
			window.addSystemMsg && window.addSystemMsg(successMessage);
		}).catch((error) => {
			console.error('Clipboard write failed:', error);
			showFallbackCopy(text, errorPrefix);
		});
	} else {
		showFallbackCopy(text, errorPrefix);
	}
}
function showFallbackCopy(text, prefix) {
	// prompt is intrusive but works in many old environments
	if (typeof prompt === 'function') {
		try {
			prompt(prefix, text);
		} catch (e) {
			window.addSystemMsg && window.addSystemMsg(t('action.copy_not_supported', 'Copy not supported in this environment'));
		}
	} else {
		window.addSystemMsg && window.addSystemMsg(t('action.copy_not_supported', 'Copy not supported in this environment'));
	}
}

// ---------------------- Validation ----------------------

function validateRoomData(roomData) {
	if (!roomData) {
		return { valid: false, error: 'No room data available' };
	}
	if (!roomData.roomName || roomData.roomName.trim() === '') {
		return { valid: false, error: 'Room name is required' };
	}
	return { valid: true };
}

// ---------------------- XSS-safe SVG sanitizer ----------------------
// Basic sanitizer: remove <script> tags, strip on* attributes and javascript: URIs and external href/src
function sanitizeSvg(svgString) {
	if (typeof svgString !== 'string') return '';
	// remove script tags
	let s = svgString.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
	// remove event handler attributes: on*
	s = s.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
	// remove javascript: in href/src
	s = s.replace(/\s(?:href|xlink:href|src)\s*=\s*(['"])\s*javascript:[^'"]*\1/gi, '');
	// remove external resources (image with href starting with http(s)://) if you want strictness:
	// s = s.replace(/\s(?:href|xlink:href|src)\s*=\s*(['"])\s*https?:\/\/[^'"]*\1/gi, '');
	return s;
}

// ---------------------- Main header & rendering ----------------------

export function renderMainHeader() {
	const rd = roomsData[activeRoomIndex];
	const roomName = rd && rd.roomName ? rd.roomName : 'Room';
	let onlineCount = 0;
	if (rd && Array.isArray(rd.userList)) {
		onlineCount = rd.userList.length;
		// if our id is not in list, add ourselves visually
		if (!rd.userList.some(u => u.clientId === rd.myId)) onlineCount += 1;
	}
	const safeRoomName = escapeHTML(roomName);
	const headerEl = $id('main-header');
	if (!headerEl) return;

	headerEl.innerHTML = `
		<button class="mobile-menu-btn" id="mobile-menu-btn" aria-label="Open Sidebar">
			<svg width="35px" height="35px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">...</svg>
		</button>
		<div class="main-header-center" id="main-header-center">
			<div class="main-header-flex">
				<div class="group-title group-title-bold">#${safeRoomName}</div>
				<span class="main-header-members">${onlineCount} ${t('ui.members', 'members')}</span>
			</div>
		</div>
		<div class="main-header-actions">
			<button class="more-btn" id="more-btn" aria-label="More Options">
				<svg width="35px" height="35px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">...</svg>
			</button>
			<button class="mobile-info-btn" id="mobile-info-btn" aria-label="Open Members">
				<svg width="35px" height="35px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">...</svg>
			</button>
			<div class="more-menu" id="more-menu" style="display:none">
				<div class="more-menu-item" data-action="share">${t('action.share', 'Share')}</div>
				<div class="more-menu-item" data-action="exit">${t('action.exit', 'Quit')}</div>
			</div>
		</div>
	`;

	setupMoreBtnMenu();
	setupMobileUIHandlers();
}

// ---------------------- Mobile UI handlers (consolidated) ----------------------

export function setupMobileUIHandlers() {
	const sidebar = document.getElementById('sidebar');
	const rightbar = document.getElementById('rightbar');
	const settingsSidebar = document.getElementById('settings-sidebar');
	const mobileMenuBtn = document.getElementById('mobile-menu-btn');
	const mobileInfoBtn = document.getElementById('mobile-info-btn');
	const sidebarMask = document.getElementById('mobile-sidebar-mask');
	const rightbarMask = document.getElementById('mobile-rightbar-mask');

	function isMobile() {
		return window.innerWidth <= 768;
	}

	function updateMobileBtnDisplay() {
		if (isMobile()) {
			if (mobileMenuBtn) mobileMenuBtn.style.display = 'flex';
			if (mobileInfoBtn) mobileInfoBtn.style.display = 'flex';
		} else {
			if (mobileMenuBtn) mobileMenuBtn.style.display = 'none';
			if (mobileInfoBtn) mobileInfoBtn.style.display = 'none';
			if (sidebar) sidebar.classList.remove('mobile-open');
			if (rightbar) rightbar.classList.remove('mobile-open');
			if (sidebarMask) sidebarMask.classList.remove('active');
			if (rightbarMask) rightbarMask.classList.remove('active');
		}
	}
	updateMobileBtnDisplay();
	window.removeEventListener('resize', updateMobileBtnDisplay); // avoid duplicate listeners
	window.addEventListener('resize', updateMobileBtnDisplay);

	// open/close handlers
	function openSidebar() {
		if (!sidebar || !sidebarMask) return;
		sidebar.classList.add('mobile-open');
		sidebarMask.classList.add('active');
	}
	function closeSidebar() {
		if (!sidebar || !sidebarMask) return;
		sidebar.classList.remove('mobile-open');
		sidebarMask.classList.remove('active');
	}
	function openRightbar() {
		if (!rightbar || !rightbarMask) return;
		rightbar.classList.add('mobile-open');
		rightbarMask.classList.add('active');
	}
	function closeRightbar() {
		if (!rightbar || !rightbarMask) return;
		rightbar.classList.remove('mobile-open');
		rightbarMask.classList.remove('active');
	}

	if (mobileMenuBtn && sidebar && sidebarMask) {
		mobileMenuBtn.onclick = function(e) {
			e.stopPropagation();
			openSidebar();
		};
		sidebarMask.onclick = function() {
			// if settings sidebar open, prioritize closing settings
			if (settingsSidebar && settingsSidebar.classList.contains('mobile-open')) {
				closeSettingsPanel();
			} else {
				closeSidebar();
			}
		};
	}

	if (mobileInfoBtn && rightbar && rightbarMask) {
		mobileInfoBtn.onclick = function(e) {
			e.stopPropagation();
			openRightbar();
		};
		rightbarMask.onclick = function() {
			closeRightbar();
		};
	}

	// Consolidated document click to close sidebars/panels
	function onDocumentClick(ev) {
		const settingsBtn = $id('settings-btn');
		const isSettingsButtonClick = settingsBtn && settingsBtn.contains(ev.target);
		const isSettingsBackButtonClick = $id('settings-back-btn') && $id('settings-back-btn').contains(ev.target);

		// Close settings panel if click outside (desktop or mobile)
		if (settingsSidebar && (settingsSidebar.classList.contains('open') || settingsSidebar.classList.contains('mobile-open'))) {
			if (!settingsSidebar.contains(ev.target) && !isSettingsButtonClick && !isSettingsBackButtonClick) {
				closeSettingsPanel();
			}
		}

		if (isMobile()) {
			if (sidebar && sidebar.classList.contains('mobile-open')) {
				if (!sidebar.contains(ev.target) && ev.target !== mobileMenuBtn) closeSidebar();
			}
			if (settingsSidebar && settingsSidebar.classList.contains('mobile-open')) {
				const isSettingsButton = settingsBtn && settingsBtn.contains(ev.target);
				if (!settingsSidebar.contains(ev.target) && !isSettingsButton) closeSettingsPanel();
			}
			if (rightbar && rightbar.classList.contains('mobile-open')) {
				if (!rightbar.contains(ev.target) && ev.target !== mobileInfoBtn) closeRightbar();
			}
		} else {
			// Desktop: if settings open and click outside, close it
			if (settingsSidebar && settingsSidebar.classList.contains('open')) {
				const isSettingsButton = settingsBtn && settingsBtn.contains(ev.target);
				if (!settingsSidebar.contains(ev.target) && !isSettingsButton) closeSettingsPanel();
			}
		}
	}
	// ensure only one listener
	document.removeEventListener('click', onDocumentClick);
	document.addEventListener('click', onDocumentClick);
}

// ---------------------- User list rendering ----------------------

export function renderUserList(updateHeader = false) {
	const userListEl = $id('member-list');
	if (!userListEl) return;
	userListEl.innerHTML = '';

	const rd = roomsData[activeRoomIndex];
	if (!rd) return;

	const userList = Array.isArray(rd.userList) ? rd.userList : [];
	const me = userList.find(u => u.clientId === rd.myId);
	const others = userList.filter(u => u.clientId !== rd.myId);

	// Tip
	if (others.length > 0) {
		const tip = document.createElement('div');
		tip.className = 'member-tip member-tip-center';
		tip.textContent = t('ui.start_private_chat', '选择用户开始私信');
		userListEl.appendChild(tip);
	}

	if (me) userListEl.appendChild(createUserItem(me, true));
	others.forEach(u => userListEl.appendChild(createUserItem(u, false)));

	if (updateHeader) renderMainHeader();
}

// ---------------------- Create user item ----------------------

export function createUserItem(user, isMe) {
	const div = document.createElement('div');
	const rd = roomsData[activeRoomIndex];
	const isPrivateTarget = rd && user && user.clientId === rd.privateChatTargetId;
	div.className = 'member' + (isMe ? ' me' : '') + (isPrivateTarget ? ' private-chat-active' : '');
	const rawName = (user && (user.userName || user.username || user.name)) || '';
	const safeUserName = escapeHTML(rawName);
	div.innerHTML = `<span class="avatar" aria-hidden="true"></span><div class="member-info"><div class="member-name">${safeUserName}${isMe ? t('ui.me', ' (me)') : ''}</div></div>`;

	const avatarEl = div.querySelector('.avatar');
	if (avatarEl) {
		try {
			const svg = createAvatarSVG(rawName || 'User');
			avatarEl.innerHTML = sanitizeSvg(svg);
		} catch (e) {
			avatarEl.innerHTML = '';
		}
	}

	if (!isMe) {
		div.onclick = () => {
			try {
				togglePrivateChat(user.clientId, safeUserName);
			} catch (e) {
				console.error('togglePrivateChat error', e);
			}
		};
	}
	return div;
}

// ---------------------- More button menu ----------------------

export function setupMoreBtnMenu() {
	const btn = $id('more-btn');
	const menu = $id('more-menu');
	if (!btn || !menu) return;
	let animating = false;

	function openMenu() {
		if (!menu) return;
		menu.style.display = 'block';
		menu.classList.remove('close');
		// force reflow
		menu.offsetHeight;
		menu.classList.add('open');
	}

	function closeMenu() {
		if (animating || !menu) return;
		animating = true;
		menu.classList.remove('open');
		menu.classList.add('close');
		setTimeout(() => {
			if (menu.classList.contains('close')) menu.style.display = 'none';
			animating = false;
		}, 300);
	}

	btn.onclick = function(e) {
		e.stopPropagation();
		if (menu.classList.contains('open')) closeMenu();
		else openMenu();
	};

	menu.onclick = function(e) {
		const target = e.target;
		if (target && target.classList.contains('more-menu-item')) {
			const action = target.dataset && target.dataset.action;
			executeMenuAction(action, closeMenu);
		}
	};

	// ensure single global click listener for hiding menu
	function onDocClick(ev) {
		if (!menu || !btn) return;
		if (!menu.contains(ev.target) && ev.target !== btn) closeMenu();
	}
	document.removeEventListener('click', onDocClick);
	document.addEventListener('click', onDocClick);

	menu.addEventListener('animationend', () => { animating = false; });
	menu.addEventListener('transitionend', () => { animating = false; });
}

// ---------------------- Menu actions ----------------------

function executeMenuAction(action, closeMenuCallback) {
	try {
		switch (action) {
			case 'share':
				handleShareAction();
				break;
			case 'exit':
				handleExitAction();
				break;
			default:
				console.warn('Unknown menu action:', action);
		}
	} catch (error) {
		console.error('Menu action failed:', error);
		window.addSystemMsg && window.addSystemMsg(t('action.action_failed', 'Action failed. Please try again.'));
	} finally {
		closeMenuCallback && closeMenuCallback();
	}
}

function handleShareAction() {
	const rd = roomsData[activeRoomIndex];
	const validation = validateRoomData(rd);
	if (!validation.valid) {
		window.addSystemMsg && window.addSystemMsg(`${t('action.cannot_share', 'Cannot share:')} ${validation.error}`);
		return;
	}

	const roomName = (rd.roomName || '').trim();
	const password = rd.password || '';

	const encryptedRoom = simpleEncrypt(roomName);
	const encryptedPwd = password ? simpleEncrypt(password) : '';

	let url = `${location.origin}${location.pathname}?r=${encodeURIComponent(encryptedRoom)}`;
	if (encryptedPwd) url += `&p=${encodeURIComponent(encryptedPwd)}`;

	copyToClipboard(url, t('action.share_copied', 'Share link copied!'), t('action.copy_url_failed', 'Copy failed, url:'));
}

function handleExitAction() {
	try {
		const result = exitRoom();
		if (!result) location.reload();
	} catch (error) {
		console.error('Exit room failed:', error);
		location.reload();
	}
}

// ---------------------- Prevent space input ----------------------
// Only block the space character and control characters, allow punctuation and common username chars.
// This avoids blocking normal hyphens/underscores/etc.
export function preventSpaceInput(input) {
	if (!input) return;
	input.addEventListener('keydown', function(e) {
		// Block SPACE only
		if (e.key === ' ') {
			e.preventDefault();
		}
		// Optionally block control chars
		if (e.key.length === 1 && /[\u0000-\u001f]/.test(e.key)) {
			e.preventDefault();
		}
	});
	input.addEventListener('input', function() {
		// Remove control characters only; keep punctuation
		this.value = this.value.replace(/[\u0000-\u001f]/g, '');
	});
}

// ---------------------- Login form handling ----------------------

export function loginFormHandler(modal) {
	return function(e) {
		e.preventDefault();

		let userName = '';
		let roomName = '';
		let password = '';
		let btn = null;
		let roomInput = null;

		if (modal) {
			const userEl = document.getElementById('userName-modal');
			const roomEl = document.getElementById('roomName-modal');
			const pwdEl = document.getElementById('password-modal');
			btn = modal.querySelector('.login-btn');
			if (userEl) userName = (userEl.value || '').trim();
			if (roomEl) {
				roomName = (roomEl.value || '').trim();
				roomInput = roomEl;
			}
			if (pwdEl) password = (pwdEl.value || '').trim();
		} else {
			const userEl = document.getElementById('userName');
			const roomEl = document.getElementById('roomName');
			const pwdEl = document.getElementById('password');
			btn = document.querySelector('#login-form .login-btn');
			if (userEl) userName = (userEl.value || '').trim();
			if (roomEl) {
				roomName = (roomEl.value || '').trim();
				roomInput = roomEl;
			}
			if (pwdEl) password = (pwdEl.value || '').trim();
		}

		// get roomMode from global (set in main.js)
		const roomMode = window.currentRoomMode || 'e2ee';

		// cleanup previous warnTip if any
		if (roomInput && roomInput._warnTip) {
			try {
				roomInput._warnTip.remove();
			} catch (e) { /* ignore */ }
			roomInput._warnTip = null;
		}

		const exists = roomsData.some(rd => rd.roomName && rd.roomName.toLowerCase() === roomName.toLowerCase());
		if (exists) {
			if (roomInput) {
				roomInput.style.border = '1.5px solid #e74c3c';
				roomInput.style.background = '#fff6f6';
				const warnTip = document.createElement('div');
				warnTip.style.color = '#e74c3c';
				warnTip.style.fontSize = '13px';
				warnTip.style.marginTop = '4px';
				warnTip.textContent = t('ui.node_exists', 'Node already exists');
				roomInput.parentNode && roomInput.parentNode.appendChild(warnTip);
				roomInput._warnTip = warnTip;
				roomInput.focus();
			}
			if (btn) {
				btn.disabled = false;
				btn.innerText = t('ui.enter', 'ENTER');
			}
			return;
		}

		if (btn) {
			btn.disabled = true;
			btn.innerText = t('ui.connecting', 'Connecting...');
		}

		// note: joinRoom signature expected: (userName, roomName, password, roomMode, modal, callback)
		if (typeof window.joinRoom === 'function') {
			window.joinRoom(userName, roomName, password, roomMode, modal, function(success) {
				if (!success && btn) {
					btn.disabled = false;
					btn.innerText = t('ui.enter', 'ENTER');
				}
			});
		} else {
			console.error('joinRoom is not defined on window');
			if (btn) {
				btn.disabled = false;
				btn.innerText = t('ui.enter', 'ENTER');
			}
		}
	};
}

// ---------------------- Generate login form HTML ----------------------

export function generateLoginForm(isModal = false) {
	const idPrefix = isModal ? '-modal' : '';
	return `
		<div class="input-group">
			<input id="userName${idPrefix}" type="text" autocomplete="username" required minlength="1" maxlength="15" placeholder="">
			<label for="userName${idPrefix}" class="floating-label">${t('ui.username', 'Username')}</label>
		</div>
		<div class="input-group">
			<input id="roomName${idPrefix}" type="text" required minlength="1" maxlength="15" placeholder="">
			<label for="roomName${idPrefix}" class="floating-label">${t('ui.node_name', 'Node Name')}</label>
		</div>
		<div class="input-group">
			<input id="password${idPrefix}" type="password" autocomplete="${isModal ? 'off' : 'current-password'}" minlength="1" maxlength="64" placeholder="">
			<label for="password${idPrefix}" class="floating-label">${t('ui.node_password', 'Node Password')} <span class="optional">${t('ui.optional', '(optional)')}</span></label>
		</div>
		<button type="submit" class="login-btn">${t('ui.enter', 'ENTER')}</button>
	`;
}

export function openLoginModal() {
	const modal = document.createElement('div');
	modal.className = 'login-modal';
	modal.innerHTML = `
		<div class="login-modal-bg"></div>
		<div class="login-modal-card">
			<button class="login-modal-close login-modal-close-abs" aria-label="Close">&times;</button>
			<h1>${t('ui.enter_node', 'Enter a Node')}</h1>
			<form id="login-form-modal">${generateLoginForm(true)}</form>
		</div>
	`;
	document.body.appendChild(modal);
	const closeBtn = modal.querySelector('.login-modal-close');
	if (closeBtn) closeBtn.onclick = () => modal.remove();

	preventSpaceInput(modal.querySelector('#userName-modal'));
	preventSpaceInput(modal.querySelector('#roomName-modal'));
	preventSpaceInput(modal.querySelector('#password-modal'));

	const form = modal.querySelector('#login-form-modal');
	if (form) form.addEventListener('submit', loginFormHandler(modal));
	autofillRoomPwd('-modal');
}

// ---------------------- Tabs ----------------------

export function setupTabs() {
	const container = document.getElementById('member-tabs');
	if (!container) return;
	const tabs = container.children;
	for (let i = 0; i < tabs.length; i++) {
		tabs[i].onclick = function() {
			for (let j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
			this.classList.add('active');
		};
	}
}

// ---------------------- Autofill from URL ----------------------

export function autofillRoomPwd(formPrefix = '') {
	const params = new URLSearchParams(window.location.search);
	const encryptedRoom = params.get('r');
	const encryptedPwd = params.get('p');
	const plaintextRoom = params.get('node');
	const plaintextPwd = params.get('pwd');

	let roomValue = '';
	let pwdValue = '';
	let isPlaintext = false;

	if (encryptedRoom) {
		try {
			roomValue = simpleDecrypt(decodeURIComponent(encryptedRoom));
			if (encryptedPwd) pwdValue = simpleDecrypt(decodeURIComponent(encryptedPwd));
		} catch (e) {
			console.warn('autofillRoomPwd decrypt error', e);
		}
	} else if (plaintextRoom) {
		roomValue = decodeURIComponent(plaintextRoom || '');
		if (plaintextPwd) pwdValue = decodeURIComponent(plaintextPwd);
		isPlaintext = true;
		if (window.addSystemMsg) {
			window.addSystemMsg(t('system.security_warning', '⚠️ This link uses an old format. Room data is not encrypted.'), true);
		}
	}

	if (roomValue) {
		const roomInput = document.getElementById(formPrefix + 'roomName');
		if (roomInput) {
			roomInput.value = roomValue;
			roomInput.readOnly = true;
			roomInput.style.background = isPlaintext ? '#fff9e6' : '#f5f5f5';
		}

		const pwdInput = document.getElementById(formPrefix + 'password');
		if (pwdInput) {
			if (pwdValue) {
				pwdInput.value = pwdValue;
				pwdInput.readOnly = true;
				pwdInput.style.background = isPlaintext ? '#fff9e6' : '#f5f5f5';
			} else {
				// No password required: show placeholder and lock input for UX without hiding text
				pwdInput.value = '';
				pwdInput.placeholder = t('ui.no_password', 'No password required');
				pwdInput.readOnly = true;
				pwdInput.style.background = isPlaintext ? '#fff9e6' : '#f5f5f5';
			}
		}

		// Clear URL params for security
		try {
			window.history.replaceState({}, '', location.pathname);
		} catch (e) {
			// ignore
		}
	}
}

// ---------------------- Init login form ----------------------

export function initLoginForm() {
	const loginFormContainer = document.getElementById('login-form');
	if (loginFormContainer && loginFormContainer.children.length === 0) {
		loginFormContainer.innerHTML = generateLoginForm(false);
	}
	document.body.classList.add('login-page');
}

// ---------------------- Event listeners ----------------------

window.addEventListener('languageChange', () => {
	renderMainHeader();
	renderUserList(false);
	updateChatInputStyle();
});

window.addEventListener('regenerateLoginForm', () => {
	const loginFormContainer = document.getElementById('login-form');
	if (loginFormContainer) loginFormContainer.innerHTML = generateLoginForm(false);
});

// ---------------------- Flip card ----------------------

export function initFlipCard() {
	const flipCard = document.getElementById('flip-card');
	const helpBtn = document.getElementById('help-btn');
	const backBtn = document.getElementById('back-btn');
	if (!flipCard || !helpBtn || !backBtn) return;
	const flipCardInner = flipCard.querySelector('.flip-card-inner');
	if (!flipCardInner) return;

	let isFlipped = false;
	function toggleFlip() {
		isFlipped = !isFlipped;
		flipCardInner.classList.toggle('flipped', isFlipped);
	}

	helpBtn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		toggleFlip();
	});
	backBtn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		toggleFlip();
	});
}
