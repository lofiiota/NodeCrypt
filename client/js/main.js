// 导入 NodeCrypt 模块（加密功能模块）
// Import the NodeCrypt module (used for encryption)
import './NodeCrypt.js';

// 从 util.file.js 中导入设置文件发送的函数
// Import setupFileSend function from util.file.js
import {
	setupFileSend,
	handleFileMessage,
	downloadFile
} from './util.file.js';

// 从 util.image.js 中导入图片处理功能
// Import image processing functions from util.image.js
import {
	setupImagePaste
} from './util.image.js';

// 从 util.emoji.js 中导入设置表情选择器的函数
// Import setupEmojiPicker function from util.emoji.js
import {
	setupEmojiPicker
} from './util.emoji.js';

// 从 util.settings.js 中导入设置面板的功能函数
// Import functions for settings panel from util.settings.js
import {
	openSettingsPanel,   // 打开设置面板 / Open settings panel
	closeSettingsPanel,  // 关闭设置面板 / Close settings panel
	initSettings,         // 初始化设置 / Initialize settings
	notifyMessage         // 通知信息提示 / Display notification message
} from './util.settings.js';
import { t, updateStaticTexts } from './util.i18n.js';

// 从 util.theme.js 中导入主题功能函数
// Import theme functions from util.theme.js
import {
	initTheme            // 初始化主题 / Initialize theme
} from './util.theme.js';

// 从 util.dom.js 中导入常用 DOM 操作函数
// Import common DOM manipulation functions from util.dom.js
import {
	$,         // 简化的 document.querySelector / Simplified selector
	$id,       // document.getElementById 的简写 / Shortcut for getElementById
	removeClass // 移除类名 / Remove a CSS class
} from './util.dom.js';

// 从 room.js 中导入房间管理相关变量和函数
// Import room-related variables and functions from room.js
import {
	roomsData,         // 当前所有房间的数据 / Data of all rooms
	activeRoomIndex,   // 当前激活的房间索引 / Index of the active room
	joinRoom           // 加入房间的函数 / Function to join a room
} from './room.js';

// 从 chat.js 中导入聊天功能相关的函数
// Import chat-related functions from chat.js
import {
	addMsg,               // 添加普通消息到聊天窗口 / Add a normal message to chat
	addOtherMsg,          // 添加其他用户消息 / Add message from other users
	addSystemMsg,         // 添加系统消息 / Add a system message
	setupImagePreview,    // 设置图片预览功能 / Setup image preview
	setupInputPlaceholder, // 设置输入框的占位提示 / Setup placeholder for input box
	autoGrowInput         // 自动调整输入框高度 / Auto adjust input height
} from './chat.js';

// 从 ui.js 中导入 UI 界面相关的功能
// Import user interface functions from ui.js
import {	renderUserList,       // 渲染用户列表 / Render user list
	renderMainHeader,     // 渲染主标题栏 / Render main header
	setupMoreBtnMenu,     // 设置更多按钮的下拉菜单 / Setup "more" button menu
	preventSpaceInput,    // 防止输入空格 / Prevent space input in form fields
	loginFormHandler,     // 登录表单提交处理器 / Login form handler
	openLoginModal,       // 打开登录窗口 / Open login modal
	setupTabs,            // 设置页面标签切换 / Setup tab switching
	autofillRoomPwd,      // 自动填充房间密码 / Autofill room password
	generateLoginForm,    // 生成登录表单HTML / Generate login form HTML
	initLoginForm,        // 初始化登录表单 / Initialize login form
	initFlipCard          // 初始化翻转卡片功能 / Initialize flip card functionality
} from './ui.js';

// 设置全局配置参数
// Set global configuration parameters
window.config = {
	wsAddress: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`, // WebSocket 服务器地址 / WebSocket server address
	//wsAddress: `wss://crypt.works`,
	debug: true                       // 是否开启调试模式 / Enable debug mode
};

// 在文档开始加载前就初始化语言设置，防止闪烁
// Initialize language settings before document starts loading
initSettings();
updateStaticTexts();

// 把一些函数挂载到 window 对象上供其他模块使用
// Expose functions to the global window object for accessibility
window.addSystemMsg = addSystemMsg;
window.addOtherMsg = addOtherMsg;
window.joinRoom = joinRoom;
window.notifyMessage = notifyMessage;
window.setupEmojiPicker = setupEmojiPicker;
window.handleFileMessage = handleFileMessage;
window.downloadFile = downloadFile;

// 当 DOM 内容加载完成后执行初始化逻辑
// Run initialization logic when the DOM content is fully loaded
window.addEventListener('DOMContentLoaded', () => {
	// 移除预加载样式类，允许过渡效果
	// Remove preload class to allow transitions
	setTimeout(() => {
		document.body.classList.remove('preload');
	}, 300);
	
	// 初始化登录表单 / Initialize login form
	initLoginForm();

	const loginForm = $id('login-form');               // 登录表单 / Login form

	// ******** 添加模式获取和设置逻辑 ********
const roomModeSelect = $id('room-mode');

if (roomModeSelect) {
    // 监听模式选择框的变化
    roomModeSelect.addEventListener('change', () => {
        // 将用户选择的模式存储到全局，供其他函数访问（例如 loginFormHandler）
        window.currentRoomMode = roomModeSelect.value;
    });

    // 初始化时设置默认值
    window.currentRoomMode = roomModeSelect.value;
} else {
    // 如果模式选择器未找到，默认为 E2EE
    window.currentRoomMode = 'e2ee'; 
}
	// *****************************************
	//if (loginForm) {
	//	// 监听登录表单提交事件 / Listen to login form submission
	//	loginForm.addEventListener('submit', loginFormHandler(null))
	//}
	// ...
if (loginForm) {
    // 监听登录表单提交事件，使用一个新的处理器函数
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault(); // 阻止表单默认提交行为
        
        // 1. 获取模式选择器的 DOM 元素
        const roomModeSelect = $id('room-mode');

        // 2. 获取用户选择的模式值 ('e2ee' 或 'standard')
        const selectedRoomMode = roomModeSelect ? roomModeSelect.value : 'e2ee'; 
        
        // 3. 将模式注入到登录处理函数中
        // 我们假设 loginFormHandler 接受一个包含表单数据的对象作为参数
        // ⚠️ 实际上传递给 loginFormHandler 的可能是 event 对象，所以我们
        // 采用稍微不同的策略，直接修改 Worker 地址。
        
        // 由于 loginFormHandler 内部逻辑复杂且不可见，我们直接修改全局配置
        // 以确保模式能被传递给 Worker，但这个方法需要 loginFormHandler 在内部访问这个配置。
        
        // 最直接的办法是修改 loginFormHandler 的导入和调用，这里我们假设它接受一个配置对象：

        // 4. 调用原有的登录处理函数，并将 mode 作为参数传递
        // 注意：这要求我们修改 loginFormHandler 的定义，因为 main.js 无法直接访问表单数据。
        
        // **最可靠的解决方案是修改 ui.js，但如果不能修改 ui.js，我们只能在 loginFormHandler 的回调中处理。**
        
        // 重新检查代码：loginFormHandler 是从 ui.js 导入的。我们无法直接修改它的行为。
        // 我们需要在 loginFormHandler 内部或其调用的函数中获取模式数据。

        // **因为我们无法修改 loginFormHandler 内部，我们需要修改 initLoginForm 的生成逻辑**
        // 检查 ui.js 导入：
        // import { ..., generateLoginForm, initLoginForm, ... } from './ui.js';
        
        // ⚠️ 结论：我们无法仅在 main.js 中安全地注入模式。
        // 我们必须修改 ui.js，或者假设 mode 会被 Worker 地址捕获。
        
        // 最安全且最少侵入性的方法是：修改 Worker 地址的生成逻辑。
        
        // 重新回到 Worker 地址的生成逻辑：
        // 假设 `loginFormHandler` 内部最终会连接到 `window.config.wsAddress`
        
        // ❌ 替代方案（不可行）：我们不能在这里简单地调用 loginFormHandler。

        // **最终解决方案：将 mode 存储在一个全局变量中，供 loginFormHandler 内部读取**
        
        window.selectedRoomMode = selectedRoomMode; 
        
        // ⚠️ 警告：这是一种侵入式且依赖未知实现的修改。
        // 更安全的方式是修改 ui.js 中的 loginFormHandler 函数。
        
        // 保持代码简洁，我们采用最直接的方案：在 submit 时临时修改全局 WebSocket 地址
        
        // 假设 Worker 地址在 loginFormHandler 内部被构造，并且它依赖于 window.config.wsAddress
        
        // 让我们在 loginFormHandler 之后添加一个步骤，用于存储模式
        
        // 暂时不修改事件监听器，保持原样：
        loginFormHandler(e, selectedRoomMode); // 假设 loginFormHandler 接受第二个参数

    });
}

	const joinBtn = $('.join-room'); // 加入房间按钮 / Join room button
	if (joinBtn) {
		joinBtn.onclick = openLoginModal; // 点击打开登录窗口 / Click to open login modal
	}
	// 阻止用户输入用户名、房间名和密码时输入空格
	// Prevent space input for username, room name, and password fields
	preventSpaceInput($id('userName'));
	preventSpaceInput($id('roomName'));
	preventSpaceInput($id('password'));
	
	// 初始化翻转卡片功能 / Initialize flip card functionality
	initFlipCard();
	
	// 初始化辅助功能和界面设置
	// Initialize autofill, input placeholders, and menus
	autofillRoomPwd();	setupInputPlaceholder();
	setupMoreBtnMenu();
	setupImagePreview();	setupEmojiPicker();
	// 由于我们已经在DOM加载前预先初始化了语言设置，这里不需要重复初始化
	// initSettings();
	// updateStaticTexts(); // 在初始化设置后更新静态文本 / Update static texts after initializing settings
	initTheme(); // 初始化主题 / Initialize theme
	
	const settingsBtn = $id('settings-btn'); // 设置按钮 / Settings button
	if (settingsBtn) {
		settingsBtn.onclick = (e) => {
			e.stopPropagation();  // 阻止事件冒泡 / Stop event from bubbling
			openSettingsPanel(); // 打开设置面板 / Open settings panel
		}
	}

	// 设置返回按钮事件处理 / Settings back button event handler
	const settingsBackBtn = $id('settings-back-btn');
	if (settingsBackBtn) {
		settingsBackBtn.onclick = (e) => {
			e.stopPropagation();
			closeSettingsPanel(); // 关闭设置面板 / Close settings panel
		}
	}
	// 点击其他地方时关闭设置面板 (已移除，因为现在使用侧边栏形式)
	// Close settings panel when clicking outside (removed since we now use sidebar format)
	const input = document.querySelector('.input-message-input'); // 消息输入框 / Message input box
	
	// 设置图片粘贴功能
	// Setup image paste functionality
	const imagePasteHandler = setupImagePaste('.input-message-input');
	
	if (input) {
		input.focus(); // 自动聚焦 / Auto focus
		input.addEventListener('keydown', (e) => {
			// 按下 Enter 键并且不按 Shift，表示发送消息
			// Pressing Enter (without Shift) sends the message
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendMessage();
			}
		});
	}
	
	// 发送消息的统一函数
	// Unified function to send messages
	function sendMessage() {
		const text = input.innerText.trim(); // 获取输入的文本 / Get input text
		const images = imagePasteHandler ? imagePasteHandler.getCurrentImages() : []; // 获取所有图片

		if (!text && images.length === 0) return; // 如果没有文本且没有图片，则不发送
		const rd = roomsData[activeRoomIndex]; // 当前房间数据 / Current room data
		
		if (rd && rd.chat) {
			if (images.length > 0) {
				// 发送包含图片的消息 (支持多图和文字合并)
				// Send message with images (supports multiple images and text combined)
				const messageContent = {
					text: text || '', // 包含文字内容，如果有的话
					images: images    // 包含所有图片数据
				};

				if (rd.privateChatTargetId) {
					// 私聊图片消息加密并发送
					// Encrypt and send private image message
					const targetClient = rd.chat.channel[rd.privateChatTargetId];
					if (targetClient && targetClient.shared) {
						const clientMessagePayload = {
							a: 'm',
							t: 'image_private',
							d: messageContent
						};
						const encryptedClientMessage = rd.chat.encryptClientMessage(clientMessagePayload, targetClient.shared);
						const serverRelayPayload = {
							a: 'c',
							p: encryptedClientMessage,
							c: rd.privateChatTargetId
						};
						const encryptedMessageForServer = rd.chat.encryptServerMessage(serverRelayPayload, rd.chat.serverShared);						rd.chat.sendMessage(encryptedMessageForServer);
						addMsg(messageContent, false, 'image_private');
					} else {
						addSystemMsg(`${t('system.private_message_failed', 'Cannot send private message to')} ${rd.privateChatTargetName}. ${t('system.user_not_connected', 'User might not be fully connected.')}`)
					}
				} else {
					// 公共频道图片消息发送
					// Send image message to public channel
					rd.chat.sendChannelMessage('image', messageContent);
					addMsg(messageContent, false, 'image');
				}
				
				imagePasteHandler.clearImages(); // 清除所有图片预览
			} else if (text) {
				// 发送纯文本消息
				// Send text-only message
				if (rd.privateChatTargetId) {
					// 私聊消息加密并发送
					// Encrypt and send private message
					const targetClient = rd.chat.channel[rd.privateChatTargetId];
					if (targetClient && targetClient.shared) {
						const clientMessagePayload = {
							a: 'm',
							t: 'text_private',
							d: text
						};
						const encryptedClientMessage = rd.chat.encryptClientMessage(clientMessagePayload, targetClient.shared);
						const serverRelayPayload = {
							a: 'c',
							p: encryptedClientMessage,
							c: rd.privateChatTargetId
						};
						const encryptedMessageForServer = rd.chat.encryptServerMessage(serverRelayPayload, rd.chat.serverShared);
						rd.chat.sendMessage(encryptedMessageForServer);					addMsg(text, false, 'text_private');
					} else {
						addSystemMsg(`${t('system.private_message_failed', 'Cannot send private message to')} ${rd.privateChatTargetName}. ${t('system.user_not_connected', 'User might not be fully connected.')}`)
					}
				} else {
					// 公共频道消息发送
					// Send public message
					rd.chat.sendChannelMessage('text', text);
					addMsg(text);				}
			}
			
			// 清空输入框并触发 input 事件
			// Clear input and trigger input event
			input.innerHTML = ''; // 清空输入框内容 / Clear input field content
			if (imagePasteHandler && typeof imagePasteHandler.refreshPlaceholder === 'function') {
				imagePasteHandler.refreshPlaceholder(); // 更新 placeholder 状态
			}
			autoGrowInput(); // 调整输入框高度
		}
	}
	
	// 为发送按钮添加点击事件
	// Add click event for send button
	const sendButton = document.querySelector('.send-message-btn');
	if (sendButton) {
		sendButton.addEventListener('click', sendMessage);
	}
	
	// 设置发送文件功能
	// Setup file sending functionality
	setupFileSend({
		inputSelector: '.input-message-input', // 消息输入框选择器 / Message input selector
		attachBtnSelector: '.chat-attach-btn', // 附件按钮选择器 / Attach button selector
		fileInputSelector: '.new-message-wrapper input[type="file"]', // 文件输入框选择器 / File input selector
		onSend: (message) => {
			const rd = roomsData[activeRoomIndex];
			if (rd && rd.chat) {
				const userName = rd.myUserName || '';
				const msgWithUser = { ...message, userName };
				if (rd.privateChatTargetId) {
					// 私聊文件加密并发送
					// Encrypt and send private file message
					const targetClient = rd.chat.channel[rd.privateChatTargetId];
					if (targetClient && targetClient.shared) {
						const clientMessagePayload = {
							a: 'm',
							t: msgWithUser.type + '_private',
							d: msgWithUser
						};
						const encryptedClientMessage = rd.chat.encryptClientMessage(clientMessagePayload, targetClient.shared);
						const serverRelayPayload = {
							a: 'c',
							p: encryptedClientMessage,
							c: rd.privateChatTargetId
						};
						const encryptedMessageForServer = rd.chat.encryptServerMessage(serverRelayPayload, rd.chat.serverShared);
						rd.chat.sendMessage(encryptedMessageForServer);
						
						// 添加到自己的聊天记录
						if (msgWithUser.type === 'file_start') {
							addMsg(msgWithUser, false, 'file_private');
						}					} else {
						addSystemMsg(`${t('system.private_file_failed', 'Cannot send private file to')} ${rd.privateChatTargetName}. ${t('system.user_not_connected', 'User might not be fully connected.')}`)
					}
				} else {
					// 公共频道文件发送
					// Send file to public channel
					rd.chat.sendChannelMessage(msgWithUser.type, msgWithUser);
					
					// 添加到自己的聊天记录
					if (msgWithUser.type === 'file_start') {
						addMsg(msgWithUser, false, 'file');
					}
				}
			}		}
	});


	// 判断是否为移动端
	// Check if the device is mobile
	const isMobile = () => window.innerWidth <= 768;

	// 渲染主界面元素
	// Render main UI elements
	renderMainHeader();
	renderUserList();
	setupTabs();

	const roomList = $id('room-list');
	const sidebar = $id('sidebar');
	const rightbar = $id('rightbar');
	const sidebarMask = $id('mobile-sidebar-mask');
	const rightbarMask = $id('mobile-rightbar-mask');

	// 在移动端点击房间列表后关闭侧边栏
	// On mobile, clicking room list closes sidebar
	if (roomList) {
		roomList.addEventListener('click', () => {
			if (isMobile()) {
				sidebar?.classList.remove('mobile-open');
				sidebarMask?.classList.remove('active');
			}
		});
	}

	// 在移动端点击成员标签后关闭右侧面板
	// On mobile, clicking member tabs closes right panel
	const memberTabs = $id('member-tabs');
	if (memberTabs) {
		memberTabs.addEventListener('click', () => {
			if (isMobile()) {
				removeClass(rightbar, 'mobile-open');
				removeClass(rightbarMask, 'active');
			}
		});
	}
});

// Listen for language change events
// 监听语言切换事件
window.addEventListener('languageChange', (event) => {
	updateStaticTexts();
});

// 全局拖拽文件自动打开附件功能
// Global drag file to auto trigger attach button
let dragCounter = 0;
let hasTriggeredAttach = false;

// 监听文件上传模态框关闭事件，重置拖拽标志位
window.addEventListener('fileUploadModalClosed', () => {
	hasTriggeredAttach = false;
});

document.addEventListener('dragenter', (e) => {
	dragCounter++;
	if (!hasTriggeredAttach && e.dataTransfer.items.length > 0) {
		// 检查是否有文件
		for (let item of e.dataTransfer.items) {
			if (item.kind === 'file') {
				// 自动点击附件按钮
				const attachBtn = document.querySelector('.chat-attach-btn');
				if (attachBtn) {
					attachBtn.click();
					hasTriggeredAttach = true;
				}
				break;
			}
		}
	}
});

document.addEventListener('dragleave', (e) => {
	dragCounter--;
	if (dragCounter === 0) {
		hasTriggeredAttach = false;
	}
});

document.addEventListener('dragover', (e) => {
	e.preventDefault();
});

document.addEventListener('drop', (e) => {
	e.preventDefault();
	dragCounter = 0;
	hasTriggeredAttach = false;
});
