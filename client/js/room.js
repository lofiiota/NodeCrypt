// Room management logic for NodeCrypt web client (refactored & fixed)
// NodeCrypt 网页客户端的房间管理逻辑（已修复、防护并重构）

import { createAvatarSVG } from './util.avatar.js';
import { renderChatArea, addSystemMsg, updateChatInputStyle } from './chat.js';
import { renderMainHeader, renderUserList } from './ui.js';
import { escapeHTML } from './util.string.js';
import { $id } from './util.dom.js';
import { t } from './util.i18n.js';

let roomsData = [];
let activeRoomIndex = -1;

/**
 * Get a new room data object
 * 注意：knownUserIds 使用 Set 便于查重；若需要序列化，请在存储时转换为数组。
 */
export function getNewRoomData() {
  return {
    roomName: '',
    userList: [],
    userMap: {},
    myId: null,
    myUserName: '',
    chat: null,
    messages: [],
    prevUserList: [],
    knownUserIds: new Set(),
    unreadCount: 0,
    privateChatTargetId: null,
    privateChatTargetName: null,
    initCount: 0,
    isInitialized: false
  };
}

/**
 * Switch to another room by index
 */
export function switchRoom(index) {
  if (typeof index !== 'number' || index < 0 || index >= roomsData.length) return;
  activeRoomIndex = index;
  const rd = roomsData[index];

  if (rd && typeof rd.unreadCount === 'number') rd.unreadCount = 0;

  const sidebarUsername = $id('sidebar-username');
  if (sidebarUsername && rd && rd.myUserName) sidebarUsername.textContent = rd.myUserName;

  if (rd && rd.myUserName) setSidebarAvatar(rd.myUserName);

  // render UI pieces safely
  try {
    renderRooms(index);
    renderMainHeader();
    renderUserList(false);
    renderChatArea();
    updateChatInputStyle();
  } catch (e) {
    console.error('Error rendering after switchRoom:', e);
  }
}

/**
 * Set the sidebar avatar (safe insertion)
 */
export function setSidebarAvatar(userName) {
  if (!userName) return;
  const svg = createAvatarSVG(userName);
  const el = $id('sidebar-user-avatar');
  if (!el) return;
  // basic cleanup: remove <script> tags to reduce risk
  const cleanSvg = String(svg).replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  el.innerHTML = cleanSvg;
}

/**
 * Render the room list; activeId defaults to current activeRoomIndex if not provided
 */
export function renderRooms(activeId = activeRoomIndex >= 0 ? activeRoomIndex : 0) {
  const roomList = $id('room-list');
  if (!roomList) return;
  roomList.innerHTML = '';

  roomsData.forEach((rd, i) => {
    const div = document.createElement('div');
    div.className = 'room' + (i === activeId ? ' active' : '');
    div.setAttribute('data-room-index', String(i));

    // click handler
    div.addEventListener('click', () => switchRoom(i));

    const safeRoomName = escapeHTML(rd.roomName || '');
    let unreadHtml = '';
    const unreadCount = typeof rd.unreadCount === 'number' ? rd.unreadCount : 0;
    if (unreadCount && i !== activeId) {
      unreadHtml = `<span class="room-unread-badge">${unreadCount > 99 ? '99+' : unreadCount}</span>`;
    }

    div.innerHTML = `<div class="info"><div class="title">#${safeRoomName}</div></div>${unreadHtml}`;
    roomList.appendChild(div);
  });
}

/**
 * Join a room
 * 新增 roomMode 参数（传给 NodeCrypt 实例）
 */
export function joinRoom(userName, roomName, password, roomMode, modal = null, onResult) {
  const newRd = getNewRoomData();
  newRd.roomName = roomName || '';
  newRd.myUserName = userName || '';
  newRd.password = password || '';
  roomsData.push(newRd);
  const idx = roomsData.length - 1;

  // Immediately switch to this room in UI
  switchRoom(idx);

  const sidebarUsername = $id('sidebar-username');
  if (sidebarUsername) sidebarUsername.textContent = userName || '';

  setSidebarAvatar(userName || '');

  let closed = false;

  const callbacks = {
    onServerClosed: () => {
      // setStatus may not exist in this module; guard the call
      if (typeof setStatus === 'function') {
        setStatus('Node connection closed');
      } else {
        console.warn('Node connection closed (setStatus unavailable)');
      }
      if (typeof onResult === 'function' && !closed) {
        closed = true;
        onResult(false);
      }
    },
    onServerSecured: () => {
      if (modal && modal.remove) {
        try { modal.remove(); } catch (e) { /* ignore */ }
      } else {
        const loginContainer = $id('login-container');
        if (loginContainer) loginContainer.style.display = 'none';
        const chatContainer = $id('chat-container');
        if (chatContainer) chatContainer.style.display = '';
      }

      if (typeof onResult === 'function' && !closed) {
        closed = true;
        onResult(true);
      }

      try {
        addSystemMsg(t('system.secured', 'connection secured'));
      } catch (e) {
        console.warn('addSystemMsg unavailable', e);
      }
    },
    onClientSecured: (user) => handleClientSecured(idx, user),
    onClientList: (list, selfId) => handleClientList(idx, list, selfId),
    onClientLeft: (clientId) => handleClientLeft(idx, clientId),
    onClientMessage: (msg) => handleClientMessage(idx, msg)
  };

  // Create NodeCrypt instance safely
  if (typeof window.NodeCrypt !== 'function') {
    console.error('NodeCrypt not available on window; cannot join room');
    if (typeof onResult === 'function') onResult(false);
    return;
  }

  const chatInst = new window.NodeCrypt(window.config || {}, callbacks);

  // set credentials if method exists
  if (chatInst && typeof chatInst.setCredentials === 'function') {
    try {
      chatInst.setCredentials(userName, roomName, password, roomMode);
    } catch (e) {
      console.warn('setCredentials failed', e);
    }
  } else {
    console.warn('chatInst.setCredentials not available');
  }

  if (chatInst && typeof chatInst.connect === 'function') {
    try {
      chatInst.connect();
    } catch (e) {
      console.error('chatInst.connect() error', e);
    }
  } else {
    console.warn('chatInst.connect not available');
  }

  roomsData[idx].chat = chatInst;
}

/**
 * Handle the client list update
 */
export function handleClientList(idx, list, selfId) {
  const rd = roomsData[idx];
  if (!rd) return;

  const oldUserIds = new Set((rd.userList || []).map(u => u.clientId));
  const newUserIds = new Set((list || []).map(u => u.clientId));

  for (const oldId of oldUserIds) {
    if (!newUserIds.has(oldId)) {
      handleClientLeft(idx, oldId);
    }
  }

  rd.userList = Array.isArray(list) ? list : [];
  rd.userMap = {};
  rd.userList.forEach(u => { if (u && u.clientId) rd.userMap[u.clientId] = u; });

  rd.myId = selfId;

  if (activeRoomIndex === idx) {
    try {
      renderUserList(false);
      renderMainHeader();
    } catch (e) {
      console.error('Error rendering user list/main header in handleClientList', e);
    }
  }

  rd.initCount = (rd.initCount || 0) + 1;
  if (rd.initCount === 2) {
    rd.isInitialized = true;
    rd.knownUserIds = new Set((rd.userList || []).map(u => u.clientId));
  }
}

/**
 * Handle client secured (a new client info)
 */
export function handleClientSecured(idx, user) {
  const rd = roomsData[idx];
  if (!rd || !user) return;

  rd.userMap[user.clientId] = user;
  const existingUserIndex = (rd.userList || []).findIndex(u => u.clientId === user.clientId);
  if (existingUserIndex === -1) rd.userList.push(user);
  else rd.userList[existingUserIndex] = user;

  if (activeRoomIndex === idx) {
    renderUserList(false);
    renderMainHeader();
  }

  if (!rd.isInitialized) return;

  const isNew = !rd.knownUserIds || !rd.knownUserIds.has(user.clientId);
  if (isNew) {
    if (!rd.knownUserIds) rd.knownUserIds = new Set();
    rd.knownUserIds.add(user.clientId);

    const name = user.userName || user.username || user.name || t('ui.anonymous', 'Anonymous');
    const msg = `${name} ${t('system.joined', 'joined the conversation')}`;

    rd.messages.push({ type: 'system', text: msg });
    if (activeRoomIndex === idx) addSystemMsg(msg, true);
    if (typeof window.notifyMessage === 'function') {
      window.notifyMessage(rd.roomName, 'system', msg);
    }
  }
}

/**
 * Handle client left
 */
export function handleClientLeft(idx, clientId) {
  const rd = roomsData[idx];
  if (!rd) return;

  if (rd.privateChatTargetId === clientId) {
    rd.privateChatTargetId = null;
    rd.privateChatTargetName = null;
    if (activeRoomIndex === idx) updateChatInputStyle();
  }

  const user = rd.userMap && rd.userMap[clientId];
  const name = user ? (user.userName || user.username || user.name || t('ui.anonymous', 'Anonymous')) : t('ui.anonymous', 'Anonymous');
  const msg = `${name} ${t('system.left', 'left the conversation')}`;

  rd.messages.push({ type: 'system', text: msg });
  if (activeRoomIndex === idx) addSystemMsg(msg, true);

  rd.userList = (rd.userList || []).filter(u => u.clientId !== clientId);
  if (rd.userMap) delete rd.userMap[clientId];

  if (activeRoomIndex === idx) {
    renderUserList(false);
    renderMainHeader();
  }
}

/**
 * Handle client message event
 */
export function handleClientMessage(idx, msg) {
  if (!msg || typeof msg !== 'object') return;
  const newRd = roomsData[idx];
  if (!newRd) return;

  // Normalize msgType early to avoid using undefined
  const msgTypeRaw = msg.type || 'text';
  let msgType = String(msgTypeRaw);

  // Prevent processing own messages unless it's a private message
  const isOwnMessage = (msg.clientId === newRd.myId && msg.userName === newRd.myUserName);
  const isPrivateType = msgType.includes('_private');
  if (isOwnMessage && !isPrivateType) {
    return;
  }

  // === File messages handling ===
  if (msgType.startsWith('file_')) {
    // Part 1: Update message history and send notifications (for 'file_start' type)
    if (msgType === 'file_start' || msgType === 'file_start_private') {
      const data = msg.data || {};
      let realUserName = msg.userName;
      if (!realUserName && msg.clientId && newRd.userMap && newRd.userMap[msg.clientId]) {
        const u = newRd.userMap[msg.clientId];
        realUserName = u.userName || u.username || u.name;
      }
      const historyMsgType = msgType === 'file_start_private' ? 'file_private' : 'file';
      const fileId = data.fileId;
      if (fileId) {
        const messageAlreadyInHistory = (newRd.messages || []).some(m =>
          m.msgType === historyMsgType && m.text && m.text.fileId === fileId && m.userName === realUserName
        );
        if (!messageAlreadyInHistory) {
          newRd.messages.push({
            type: 'other',
            text: data,
            userName: realUserName,
            avatar: realUserName,
            msgType: historyMsgType,
            timestamp: (data && data.timestamp) || Date.now()
          });
        }
      }

      const notificationMsgType = msgType.includes('_private') ? 'private file' : 'file';
      if (typeof window.notifyMessage === 'function' && data && data.fileName) {
        window.notifyMessage(newRd.roomName, notificationMsgType, `${data.fileName}`, realUserName);
      }
    }

    // Part 2: UI handling
    if (activeRoomIndex === idx) {
      if (typeof window.handleFileMessage === 'function') {
        try {
          window.handleFileMessage(msg.data, msgType.includes('_private'));
        } catch (e) {
          console.error('handleFileMessage error', e);
        }
      }
    } else {
      // Only increment unread count for file_start types in inactive room
      if (msgType === 'file_start' || msgType === 'file_start_private') {
        newRd.unreadCount = (newRd.unreadCount || 0) + 1;
        renderRooms(activeRoomIndex);
      }
    }
    return;
  }

  // === Image detection for legacy formats ===
  if (msgType === 'image' || msgType === 'image_private') {
    // already correct
  } else if (!msgType.includes('_private')) {
    if (msg.data && typeof msg.data === 'string' && msg.data.startsWith('data:image/')) {
      msgType = 'image';
    } else if (msg.data && typeof msg.data === 'object' && msg.data.image) {
      msgType = 'image';
    }
  }

  // Determine real user display name
  let realUserName = msg.userName;
  if (!realUserName && msg.clientId && newRd.userMap && newRd.userMap[msg.clientId]) {
    const u = newRd.userMap[msg.clientId];
    realUserName = u.userName || u.username || u.name;
  }

  // Push to history
  const messageRecord = {
    type: 'other',
    text: msg.data,
    userName: realUserName,
    avatar: realUserName,
    msgType,
    timestamp: Date.now()
  };
  newRd.messages.push(messageRecord);

  // Display or mark unread
  if (activeRoomIndex === idx) {
    if (typeof window.addOtherMsg === 'function') {
      try {
        window.addOtherMsg(msg.data, realUserName, realUserName, false, msgType);
      } catch (e) {
        console.error('addOtherMsg error', e);
      }
    }
  } else {
    newRd.unreadCount = (newRd.unreadCount || 0) + 1;
    renderRooms(activeRoomIndex);
  }

  const notificationMsgType = msgType.includes('_private') ? `private ${msgType.split('_')[0]}` : msgType;
  if (typeof window.notifyMessage === 'function') {
    try {
      window.notifyMessage(newRd.roomName, notificationMsgType, msg.data, realUserName);
    } catch (e) {
      console.error('notifyMessage error', e);
    }
  }
}

/**
 * Toggle private chat with a user
 */
export function togglePrivateChat(targetId, targetName) {
  const rd = roomsData[activeRoomIndex];
  if (!rd) return;
  if (rd.privateChatTargetId === targetId) {
    rd.privateChatTargetId = null;
    rd.privateChatTargetName = null;
  } else {
    rd.privateChatTargetId = targetId;
    rd.privateChatTargetName = targetName;
  }
  renderUserList();
  updateChatInputStyle();
}

/**
 * Exit the current room
 */
export function exitRoom() {
  if (activeRoomIndex >= 0 && roomsData[activeRoomIndex]) {
    const chatInst = roomsData[activeRoomIndex].chat;
    if (chatInst) {
      if (typeof chatInst.destruct === 'function') {
        try { chatInst.destruct(); } catch (e) { console.warn('destruct error', e); }
      } else if (typeof chatInst.disconnect === 'function') {
        try { chatInst.disconnect(); } catch (e) { console.warn('disconnect error', e); }
      }
    }

    roomsData[activeRoomIndex].chat = null;
    roomsData.splice(activeRoomIndex, 1);

    if (roomsData.length > 0) {
      // switch to first room
      switchRoom(0);
      return true;
    } else {
      return false;
    }
  }
  return false;
}

export { roomsData, activeRoomIndex };

/**
 * Listen for sidebar username update event (safe handler)
 */
window.addEventListener('updateSidebarUsername', () => {
  if (activeRoomIndex >= 0 && roomsData[activeRoomIndex]) {
    const rd = roomsData[activeRoomIndex];
    const sidebarUsername = $id('sidebar-username');
    if (sidebarUsername && rd.myUserName) {
      sidebarUsername.textContent = rd.myUserName;
    }
    if (rd.myUserName) {
      setSidebarAvatar(rd.myUserName);
    }
  }
});
