/**
 * dsh-plugin-telegram
 * --------------
 * Control DeepSeek Harness from your phone via Telegram.
 *
 * - Start new sessions (`/new <prompt>`), continue existing ones (`/ask`, plain
 *   text), list/open sessions (`/list`, `/open`), cancel turns (`/cancel`),
 *   read history (`/tail`).
 * - Live push: assistant messages, turn start/end summaries, tool calls
 *   (optional), todo-list progress — forwarded to the Telegram chat linked to
 *   each session.
 * - Remote approval: DSH "ask" approval requests are forwarded to Telegram
 *   with Allow / Reject buttons; the answer is fed back into the waterfall.
 * - Remote questions: `ask_user_question` prompts are forwarded with option
 *   buttons; a plain-text reply answers with a custom answer.
 *
 * Runs as a Cordis plugin inside the DSH host process (same mechanism as
 * dsh-plugin-writing-guard). The Telegram client is a plain node:https-based
 * long-polling client with zero external dependencies; optional HTTP CONNECT
 * or SOCKS5 proxy support is provided for restricted networks.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import os from "node:os";
import tls from "node:tls";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/**
 * SOCKS5 tunnel without external dependencies: open a raw TCP socket through a
 * SOCKS5 proxy and run TLS over it (node:https + node:tls). This lets the
 * bridge use a SOCKS5 proxy (e.g. the one many campus/VPN setups expose),
 * which higher-level HTTP clients do not support natively.
 */
function socks5TcpConnect(proxyHost, proxyPort, targetHost, targetPort) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(proxyPort, proxyHost, () => {
			socket.write(Buffer.from([0x05, 0x01, 0x00])); // SOCKS5, no auth
		});
		const received = [];
		let step = 0;
		socket.on("error", reject);
		socket.on("data", (data) => {
			received.push(data);
			const buf = Buffer.concat(received);
			try {
				if (step === 0) {
					if (buf.length < 2) return;
					if (buf[0] !== 0x05 || buf[1] !== 0x00) throw new Error("socks5 handshake rejected");
					step = 1;
					const hostBuf = Buffer.from(targetHost, "utf8");
					const req = Buffer.alloc(7 + hostBuf.length);
					req[0] = 0x05;
					req[1] = 0x01; // CONNECT
					req[2] = 0x00;
					req[3] = 0x03; // DOMAINNAME (remote DNS)
					req[4] = hostBuf.length;
					hostBuf.copy(req, 5);
					req.writeUInt16BE(targetPort & 0xffff, 5 + hostBuf.length);
					socket.write(req);
				} else if (step === 1) {
					if (buf.length < 4) return;
					if (buf[0] !== 0x05) throw new Error("socks5 protocol error");
					if (buf[1] !== 0x00) throw new Error(`socks5 connect failed (code ${buf[1]})`);
					step = 2;
					socket.removeAllListeners("data");
					resolve(socket);
				}
			} catch (error) {
				socket.destroy();
				reject(error);
			}
		});
	});
}

/**
 * HTTP CONNECT tunnel: open a raw TCP socket through an HTTP(S) proxy by
 * issuing a CONNECT request, then let the caller run TLS over it.
 */
function httpConnectTunnel(proxyHost, proxyPort, targetHost, targetPort) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(proxyPort, proxyHost, () => {
			socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
		});
		let buffer = "";
		socket.on("error", reject);
		socket.on("data", (data) => {
			buffer += data.toString("latin1");
			const end = buffer.indexOf("\r\n\r\n");
			if (end < 0) return;
			const head = buffer.slice(0, end);
			if (/^HTTP\/1\.[01] 200/i.test(head)) {
				socket.removeAllListeners("data");
				resolve(socket);
			} else {
				socket.destroy();
				reject(new Error(`http proxy CONNECT failed: ${head.split("\r\n")[0] ?? head}`));
			}
		});
	});
}

/** Parse a proxy URL into {kind, host, port}; undefined when empty. */
function parseProxy(proxyUrl) {
	const value = String(proxyUrl ?? "").trim();
	if (!value) return undefined;
	const match = /^(socks5h?|https?):\/\/([^:/]+)(?::(\d+))?/i.exec(value);
	if (match === null) return undefined;
	const kind = /^socks5h?$/i.test(match[1]) ? "socks5" : "http";
	return { kind, host: match[2], port: Number(match[3]) || (kind === "socks5" ? 1080 : 8080) };
}

const name = "dsh-plugin-telegram";

const inject = [
	"agents",
	"agentDefaultModel",
	"agentPresets",
	"permissionPresets",
	"sessionQuery",
	"sessionTitle",
	"workspaceRegistry"
];

const Config = z.object({
	token: z.string().default(""),
	tokenEnv: z.string().default("DSH_TELEGRAM_TOKEN"),
	apiBaseUrl: z.string().default("https://api.telegram.org"),
	proxyUrl: z.string().default(""),
	allowedChats: z.array(z.number()).default([]),
	autoAuthorize: z.boolean().default(true),
	workspace: z.string().default(""),
	agentPreset: z.string().default("default"),
	permissionPreset: z.string().default("workspace-write"),
	modelProvider: z.string().default(""),
	modelId: z.string().default(""),
	notifyUserMessages: z.boolean().default(true),
	notifyAssistantMessages: z.boolean().default(true),
	notifyToolCalls: z.boolean().default(false),
	notifyTurnSummary: z.boolean().default(true),
	notifyTodos: z.boolean().default(true),
	forwardApprovals: z.boolean().default(true),
	forwardQuestions: z.boolean().default(true),
	approvalTimeoutSeconds: z.number().default(300),
	questionTimeoutSeconds: z.number().default(600),
	maxMessageLength: z.number().default(3800),
	pollTimeoutSeconds: z.number().default(50),
	listMax: z.number().default(8)
});

const HOME = process.env.DSH_HOME ?? join(os.homedir(), ".dsh");
const STATE_PATH = join(HOME, "telegram-bridge.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Escape text for Telegram HTML parse_mode. */
function esc(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function truncate(text, max) {
	const s = String(text ?? "");
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Extract user-visible text from a DSH content-block array. */
function contentText(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text.trim());
	}
	return parts.filter(Boolean).join("\n");
}

/** Short human title for a prompt. */
function titleFromPrompt(prompt) {
	const first = String(prompt ?? "").trim().split("\n")[0] ?? "";
	return first.length > 48 ? `${first.slice(0, 48)}…` : first;
}

const TODO_ICON = { pending: "⬜", in_progress: "🔄", completed: "✅" };

function formatTodos(todos) {
	if (!Array.isArray(todos) || todos.length === 0) return "（无待办）";
	return todos
		.map((todo) => `${TODO_ICON[todo.status] ?? "⬜"} ${esc(todo.content)}`)
		.join("\n");
}

function formatTime(ms) {
	const d = new Date(ms);
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shortId() {
	return randomUUID().replaceAll("-", "").slice(0, 8);
}

// NOT `export default function` — the loader's unwrapExports() picks
// `exports.default` and drops the rest of the module namespace, so a default
// export function loses its sibling `inject` / `name` / `Config` metadata and
// cordis registers it with NO inject: the bridge starts and polls fine, but
// every this.ctx.<service> access then throws "cannot get property ...
// without inject". Exporting `apply` as a named export (no default) makes the
// loader pass the whole module namespace as the plugin object, which carries
// the metadata — the same shape as dsh-time-context and the other
// function-style dsh plugins.
function apply(ctx, config) {
	// The loader instantiates plugins with the entry's `config` — which may be
	// undefined when no `config:` block exists on the entry. Never let that
	// crash the host plugin tree: treat it as an empty config and fall back to
	// the environment variable.
	config = config ?? {};
	config.allowedChats = Array.isArray(config.allowedChats) ? config.allowedChats : [];
	const tokenEnv = config.tokenEnv ?? "DSH_TELEGRAM_TOKEN";
	const token = String(config.token ?? "").trim() || (process.env[tokenEnv] ?? "").trim();
	if (!token) {
		ctx.logger.warn("dsh-plugin-telegram: no bot token (config `token` or env " + tokenEnv + "); plugin disabled");
		return;
	}
	const bridge = new TelegramBridge(ctx, config, token);
	bridge.start();
	ctx.on("dispose", () => bridge.stop());
}

class TelegramBridge {
	constructor(ctx, config, token) {
		this.ctx = ctx;
		this.cfg = config ?? {};
		this.token = token;
		this.apiBase = (this.cfg.apiBaseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
		this.proxy = undefined;
		this.stopped = false;
		this.offset = 0;
		this.failures = 0;
		this.pollTimer = undefined;
		// state
		this.state = this.loadState();
		// runtime registries
		this.pending = new Map(); // shortId -> {kind, resolve, timer, chatId, messageId, sessionId, questions?}
		this.turnMessages = new Map(); // sessionId -> {chatId, messageId}
		this.todoMessages = new Map(); // sessionId -> {chatId, messageId}
		this.shortSessions = new Map(); // shortId -> sessionId (for /open by short id)
		this.knownSessions = new Set();
		this.saveTimer = undefined;
	}

	// ------------------------------------------------------------------ state

	loadState() {
		try {
			if (existsSync(STATE_PATH)) {
				const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
				if (raw && typeof raw === "object" && Array.isArray(raw.chats)) return raw;
			}
		} catch (error) {
			this.ctx.logger.warn(`dsh-plugin-telegram: cannot read state file: ${error instanceof Error ? error.message : error}`);
		}
		return { version: 1, chats: {}, sessions: {} };
	}

	scheduleSave() {
		if (this.saveTimer !== undefined) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.saveState();
		}, 500);
	}

	saveState() {
		try {
			mkdirSync(HOME, { recursive: true });
			const tmp = `${STATE_PATH}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
			renameSync(tmp, STATE_PATH);
		} catch (error) {
			this.ctx.logger.warn(`dsh-plugin-telegram: cannot write state file: ${error instanceof Error ? error.message : error}`);
		}
	}

	// ---------------------------------------------------------------- lifecycle

	async start() {
		// Retry the initial getMe until it succeeds: the machine may boot
		// before the local proxy (or network) is up, and a phone-control
		// bridge must become available on its own instead of staying dead
		// until the next host restart. stop() breaks the loop via this.stopped.
		let attempt = 0;
		while (!this.stopped) {
			try {
				this.proxy = parseProxy(this.cfg.proxyUrl);
				if (this.proxy !== undefined && attempt === 0) {
					this.ctx.logger.info(`dsh-plugin-telegram: using ${this.proxy.kind} proxy ${this.proxy.host}:${this.proxy.port}`);
				}
				const me = await this.api("getMe");
				this.ctx.logger.info(`dsh-plugin-telegram: bridge started as @${me.username} (chat(s): ${this.authorizedList() || "auto"})`);
				if (this.authorizedList()) {
					for (const chatId of this.cfg.allowedChats) {
						this.send(chatId, `✅ DSH 已连接 Telegram（bot @${esc(me.username)}）。`).catch(() => {});
					}
				}
				// Register the "/" quick-command menu Telegram clients show.
				// Non-fatal: commands keep working even if registration fails.
				this.registerCommands().catch((error) => {
					this.ctx.logger.warn(`dsh-plugin-telegram: setMyCommands failed: ${error instanceof Error ? error.message : error}`);
				});
				break;
			} catch (error) {
				attempt += 1;
				this.ctx.logger.warn(`dsh-plugin-telegram: failed to start (attempt ${attempt}; is the bot token valid and is api.telegram.org reachable?): ${error instanceof Error ? error.message : error}`);
				if (this.stopped) return;
				await sleep(Math.min(60000, 3000 * attempt));
			}
		}
		if (this.stopped) return;
		this.disposeEvents = [
			this.ctx.on("session/created", (session) => this.onSessionCreated(session)),
			this.ctx.on("session/event", (session, event) => this.onSessionEvent(session, event)),
			this.ctx.on("session/disposed", (session) => this.onSessionDisposed(session)),
			this.ctx.on("approval/request", (request, next) => this.onApproval(request, next)),
			this.ctx.on("user-questions/request", (request, next) => this.onQuestion(request, next))
		];
		this.pollLoop().catch((error) => {
			this.ctx.logger.warn(`dsh-plugin-telegram: polling loop ended: ${error instanceof Error ? error.message : error}`);
		});
	}

	stop() {
		this.stopped = true;
		if (Array.isArray(this.disposeEvents)) {
			for (const dispose of this.disposeEvents) {
				try {
					dispose();
				} catch { /* ignore */ }
			}
			this.disposeEvents = undefined;
		}
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			try {
				if (pending.kind === "approval") pending.resolve("cancelled");
				else if (pending.kind === "question") pending.resolve({ answers: pending.questions.map((q) => ({ id: q.id, selected: [] })) });
			} catch { /* ignore */ }
		}
		this.pending.clear();
		this.saveState();
	}

	authorizedList() {
		return this.cfg.allowedChats.length > 0 ? this.cfg.allowedChats.join(",") : "";
	}

	isAuthorized(chatId) {
		if (this.cfg.allowedChats.includes(chatId)) return true;
		if (this.cfg.allowedChats.length === 0 && this.cfg.autoAuthorize) {
			this.state.chats[String(chatId)] ??= { current: null, linked: [], todo: {} };
			this.scheduleSave();
			return true;
		}
		return false;
	}

	chatRecord(chatId) {
		let record = this.state.chats[String(chatId)];
		if (record === undefined) {
			record = { current: null, linked: [], todo: {} };
			this.state.chats[String(chatId)] = record;
		}
		return record;
	}

	// ----------------------------------------------------------------- Telegram API

	/** Open a TLS socket to the Bot API host, directly or through the proxy. */
	async openTlsSocket(hostname, port) {
		let raw;
		if (this.proxy === undefined) {
			const sock = tls.connect({ host: hostname, port, servername: hostname });
			await new Promise((resolve, reject) => {
				sock.once("secureConnect", resolve);
				sock.once("error", reject);
			});
			return sock;
		}
		if (this.proxy.kind === "socks5") {
			raw = await socks5TcpConnect(this.proxy.host, this.proxy.port, hostname, port);
		} else {
			raw = await httpConnectTunnel(this.proxy.host, this.proxy.port, hostname, port);
		}
		const sock = tls.connect({ socket: raw, servername: hostname });
		await new Promise((resolve, reject) => {
			sock.once("secureConnect", resolve);
			sock.once("error", reject);
		});
		return sock;
	}

	/** Minimal HTTPS client for the Bot API (raw TLS socket + HTTP/1.1, no deps). */
	async rawRequest(url, method, headers, body, timeoutMs) {
		const sock = await this.openTlsSocket(url.hostname, Number(url.port || 443));
		return await new Promise((resolve, reject) => {
			let settled = false;
			let buffer = "";
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				sock.destroy();
				reject(new Error(`request timeout after ${timeoutMs}ms`));
			}, timeoutMs);
			const finish = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error !== undefined) {
					reject(error);
					return;
				}
				const sep = buffer.indexOf("\r\n\r\n");
				if (sep < 0) {
					reject(new Error("malformed HTTP response"));
					return;
				}
				const head = buffer.slice(0, sep);
				const text = buffer.slice(sep + 4);
				const status = Number.parseInt(head.split(" ")[1] ?? "0", 10);
				resolve({ status, text });
			};
			sock.on("error", (error) => finish(error));
			sock.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
			});
			sock.on("end", () => finish());
			sock.on("close", () => finish());
			const head = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n` +
				`Host: ${url.host}\r\n` +
				`Connection: close\r\n` +
				Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n") +
				"\r\n\r\n";
			sock.write(head + body);
		});
	}

	async api(method, params = {}) {
		const timeoutMs = typeof params._timeoutMs === "number" ? params._timeoutMs : 20000;
		delete params._timeoutMs;
		const url = new URL(`${this.apiBase}/bot${this.token}/${method}`);
		const body = JSON.stringify(params);
		let res;
		try {
			res = await this.rawRequest(url, "POST", {
				"Content-Type": "application/json",
				"Content-Length": String(Buffer.byteLength(body)),
				"User-Agent": "dsh-plugin-telegram/0.1.1"
			}, body, timeoutMs);
		} catch (error) {
			const wrapped = new Error(`telegram ${method} transport: ${error instanceof Error ? error.message : error}`);
			wrapped.transport = true;
			throw wrapped;
		}
		let data;
		try {
			data = JSON.parse(res.text);
		} catch {
			data = { ok: false, description: truncate(res.text, 200) };
		}
		if (data.ok !== true) {
			const err = new Error(`telegram ${method}: ${data.description ?? "unknown error"}`);
			err.telegram = data;
			throw err;
		}
		return data.result;
	}

	async send(chatId, text, options = {}) {
		return this.api("sendMessage", {
			chat_id: chatId,
			text: truncate(text, this.cfg.maxMessageLength),
			parse_mode: "HTML",
			disable_web_page_preview: true,
			...options
		});
	}

	async edit(chatId, messageId, text, options = {}) {
		try {
			return await this.api("editMessageText", {
				chat_id: chatId,
				message_id: messageId,
				text: truncate(text, this.cfg.maxMessageLength),
				parse_mode: "HTML",
				disable_web_page_preview: true,
				...options
			});
		} catch (error) {
			// message may have been deleted or is too old to edit — ignore
			this.ctx.logger.debug(`dsh-plugin-telegram: editMessageText failed: ${error instanceof Error ? error.message : error}`);
			return undefined;
		}
	}

	async answerCallback(queryId, text) {
		try {
			await this.api("answerCallbackQuery", { callback_query_id: queryId, text, show_alert: false });
		} catch { /* ignore */ }
	}

	async sendTyping(chatId) {
		try {
			await this.api("sendChatAction", { chat_id: chatId, action: "typing" });
		} catch { /* ignore */ }
	}

	/**
	 * Register the "/" command menu (the autocomplete list Telegram clients
	 * show when the user types "/"). Mirrors the switch in onCommand(); only
	 * primary names are listed — aliases (/link, /sessions) still work but
	 * would clutter the menu.
	 */
	async registerCommands() {
		await this.api("setMyCommands", {
			commands: [
				{ command: "new", description: "新建会话并开始任务" },
				{ command: "ask", description: "继续当前会话" },
				{ command: "list", description: "列出最近的会话" },
				{ command: "open", description: "切换到指定会话" },
				{ command: "tail", description: "查看最近几条消息" },
				{ command: "status", description: "会话状态与待办" },
				{ command: "cancel", description: "取消当前回合" },
				{ command: "help", description: "查看帮助" },
				{ command: "start", description: "开始使用" },
				{ command: "ping", description: "连通性测试" }
			]
		});
	}

	// ------------------------------------------------------------- polling loop

	async pollLoop() {
		while (!this.stopped) {
			try {
				const updates = await this.api("getUpdates", {
					offset: this.offset,
					timeout: this.cfg.pollTimeoutSeconds,
					allowed_updates: ["message", "callback_query", "my_chat_member"],
					_timeoutMs: (this.cfg.pollTimeoutSeconds + 30) * 1000
				});
				this.failures = 0;
				for (const update of updates) {
					if (update.update_id !== undefined && update.update_id >= this.offset) this.offset = update.update_id + 1;
					try {
						await this.handleUpdate(update);
					} catch (error) {
						this.ctx.logger.warn(`dsh-plugin-telegram: update ${update.update_id} failed: ${error instanceof Error ? error.message : error}`);
					}
				}
			} catch (error) {
				this.failures += 1;
				if (!this.stopped) {
					this.ctx.logger.warn(`dsh-plugin-telegram: getUpdates failed (attempt ${this.failures}): ${error instanceof Error ? error.message : error}`);
					await sleep(Math.min(30000, 1500 * this.failures));
				}
			}
		}
	}

	async handleUpdate(update) {
		if (update.message !== undefined) await this.onMessage(update.message);
		else if (update.callback_query !== undefined) await this.onCallbackQuery(update.callback_query);
	}

	// ---------------------------------------------------------------- messages

	async onMessage(message) {
		const chatId = message.chat?.id;
		if (chatId === undefined) return;
		if (!this.isAuthorized(chatId)) return;

		const text = (message.text ?? "").trim();
		const replyTo = message.reply_to_message?.message_id;

		// a plain-text reply to a pending question message = custom answer
		if (replyTo !== undefined && text !== "" && !text.startsWith("/")) {
			for (const pending of this.pending.values()) {
				if (pending.kind === "question" && pending.chatId === chatId && pending.messageId === replyTo) {
					this.answerCustomQuestion(pending, text, message.message_id).catch((error) => {
						this.ctx.logger.warn(`dsh-plugin-telegram: answerCustomQuestion failed: ${error instanceof Error ? error.message : error}`);
					});
					return;
				}
			}
		}

		if (text.startsWith("/")) {
			await this.onCommand(chatId, text, message);
			return;
		}

		// a pending single question without options can be answered with any plain text
		if (text !== "") {
			let candidate;
			for (const pending of this.pending.values()) {
				if (pending.kind === "question" && pending.chatId === chatId && pending.questions.length === 1 && !pending.questions[0].options?.length) {
					candidate = pending;
				}
			}
			if (candidate !== undefined) {
				this.answerCustomQuestion(candidate, text).catch((error) => {
					this.ctx.logger.warn(`dsh-plugin-telegram: answerCustomQuestion failed: ${error instanceof Error ? error.message : error}`);
				});
				return;
			}
		}

		// plain text → followup to the chat's current session
		const record = this.chatRecord(chatId);
		if (!record.current) {
			await this.send(chatId, "ℹ️ 还没有当前会话。用 <code>/new 任务描述</code> 新建，或用 <code>/list</code> 选择已有会话。");
			return;
		}
		await this.sendTyping(chatId);
		await this.sendToSession(chatId, record.current, text);
	}

	async onCommand(chatId, text, message) {
		const [rawCmd, ...rest] = text.split(/\s+/);
		const cmd = rawCmd.toLowerCase();
		const args = rest.join(" ").trim();
		const cmdName = cmd.split("@")[0];

		switch (cmdName) {
			case "/start":
			case "/help":
				await this.sendHelp(chatId);
				return;
			case "/new":
				if (!args) {
					await this.send(chatId, "用法：<code>/new 任务描述</code>\n例如：<code>/new 分析一下当前目录的代码结构</code>");
					return;
				}
				await this.createSession(chatId, args);
				return;
			case "/ask": {
				// /ask [sessionId] <prompt>
				let sessionId = this.chatRecord(chatId).current;
				let prompt = args;
				const first = args.split(/\s+/)[0] ?? "";
				if (this.lookupSessionId(first) !== undefined) {
					sessionId = this.lookupSessionId(first);
					prompt = args.slice(first.length).trim();
				}
				if (!sessionId) {
					await this.send(chatId, "没有当前会话。用 <code>/open &lt;sessionId&gt;</code> 选择，或 <code>/new</code> 新建。");
					return;
				}
				if (!prompt) {
					await this.send(chatId, "用法：<code>/ask 要继续说的内容</code>，或 <code>/ask &lt;sessionId&gt; 内容</code>");
					return;
				}
				await this.sendTyping(chatId);
				await this.sendToSession(chatId, sessionId, prompt);
				return;
			}
			case "/open":
			case "/link": {
				if (!args) {
					await this.send(chatId, "用法：<code>/open &lt;sessionId&gt;</code>（支持短 id）");
					return;
				}
				const sessionId = this.lookupSessionId(args);
				if (sessionId === undefined) {
					await this.send(chatId, `找不到会话 <code>${esc(args)}</code>。用 <code>/list</code> 查看可用的会话。`);
					return;
				}
				await this.openSession(chatId, sessionId);
				return;
			}
			case "/list":
			case "/sessions": {
				const n = Number.parseInt(args, 10) || this.cfg.listMax;
				await this.listSessions(chatId, Math.min(n, 15));
				return;
			}
			case "/tail": {
				// /tail [sessionId] [n]
				const parts = args.split(/\s+/).filter(Boolean);
				let sessionId = this.chatRecord(chatId).current;
				let n = 5;
				if (parts.length > 0) {
					const maybe = this.lookupSessionId(parts[0]);
					if (maybe !== undefined) {
						sessionId = maybe;
						if (parts[1] !== undefined) n = Number.parseInt(parts[1], 10) || 5;
					} else {
						n = Number.parseInt(parts[0], 10) || 5;
					}
				}
				if (!sessionId) {
					await this.send(chatId, "没有当前会话。");
					return;
				}
				await this.tailSession(chatId, sessionId, n);
				return;
			}
			case "/cancel": {
				let sessionId = this.chatRecord(chatId).current;
				if (args) {
					const maybe = this.lookupSessionId(args);
					if (maybe !== undefined) sessionId = maybe;
				}
				if (!sessionId) {
					await this.send(chatId, "没有当前会话。");
					return;
				}
				const agent = this.ctx.agents.get(sessionId);
				if (!agent) {
					await this.send(chatId, "该会话当前没有运行中的 Agent。");
					return;
				}
				try {
					agent.cancel({ kind: "user" }, { keepInbox: true });
					await this.send(chatId, "⏹ 已请求取消当前回合。");
				} catch (error) {
					await this.send(chatId, `取消失败：${esc(error instanceof Error ? error.message : error)}`);
				}
				return;
			}
			case "/status": {
				let sessionId = this.chatRecord(chatId).current;
				if (args) {
					const maybe = this.lookupSessionId(args);
					if (maybe !== undefined) sessionId = maybe;
				}
				if (!sessionId) {
					await this.send(chatId, "没有当前会话。");
					return;
				}
				await this.statusSession(chatId, sessionId);
				return;
			}
			case "/ping":
				await this.send(chatId, "pong 🏓");
				return;
			default:
				await this.send(chatId, `未知命令 <code>${esc(cmdName)}</code>。发送 <code>/help</code> 查看用法。`);
		}
	}

	async sendHelp(chatId) {
		const lines = [
			"🤖 <b>DSH × Telegram 桥接</b>",
			"",
			"<b>开始任务</b>",
			"<code>/new 任务描述</code> — 新建会话并开始",
			"<code>/list</code> — 列出最近的会话",
			"<code>/open &lt;id&gt;</code> — 选择当前会话",
			"",
			"<b>继续对话</b>",
			"直接发文字 → 发给当前会话",
			"<code>/ask 内容</code> — 显式继续当前会话",
			"<code>/ask &lt;sessionId&gt; 内容</code> — 指定会话",
			"",
			"<b>查看</b>",
			"<code>/tail [n]</code> — 最近 n 条消息（默认 5）",
			"<code>/status</code> — 会话状态与待办",
			"<code>/cancel</code> — 取消当前回合",
			"<code>/ping</code> — 连通性测试",
			"",
			"<b>推送与审批</b>",
			"会话被 /open 或 /new 关联后，助手回复、回合进度、待办都会实时推送。",
			"DSH 需要审批或提问时也会推送到这里，用按钮或直接回复即可。",
			""
		];
		await this.send(chatId, lines.join("\n"));
	}

	// ------------------------------------------------------------ session ops

	lookupSessionId(input) {
		if (!input) return undefined;
		const value = input.trim();
		if (value.startsWith("/")) return undefined;
		// exact id
		if (this.knownSessions.has(value)) return value;
		// short id registered in this process
		if (this.shortSessions.has(value)) return this.shortSessions.get(value);
		// id of any session linked to any chat
		if (this.state.sessions[value] !== undefined) return value;
		return undefined;
	}

	async listSessions(chatId, limit) {
		try {
			const records = await this.ctx.sessionQuery.listSessions();
			if (records.length === 0) {
				await this.send(chatId, "目前没有任何会话。用 <code>/new</code> 开始第一个。");
				return;
			}
			records.sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0));
			const top = records.slice(0, limit);
			const titles = await Promise.allSettled(top.map((r) => this.ctx.sessionQuery.readTitle(r.header.id)));
			const lines = ["📚 <b>最近的会话</b>", ""];
			const keyboard = [];
			for (let i = 0; i < top.length; i++) {
				const record = top[i];
				const id = record.header.id;
				this.knownSessions.add(id);
				const short = shortId();
				this.shortSessions.set(short, id);
				const title = titles[i]?.status === "fulfilled" ? titles[i].value : "";
				const live = this.ctx.agents.get(id) !== undefined;
				const agent = live ? this.ctx.agents.get(id) : undefined;
				const running = agent?.status === "running";
				const current = this.chatRecord(chatId).current === id;
				const state = running ? "🟢 运行中" : live ? "⚪ 空闲" : "⚫ 未加载";
				lines.push(`<code>${i + 1}</code>. <b>${esc(title || id)}</b> ${current ? "📍" : ""}`);
				lines.push(`   ${state} · ${formatTime(record.header.createdAt ?? 0)} · <code>${esc(short)}</code>`);
				keyboard.push([{ text: `打开 ${i + 1}`, callback_data: `s:${short}` }]);
			}
			lines.push("", "提示：<code>/open 短id</code> 选择会话；<code>/tail</code> 看历史。");
			await this.send(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: keyboard } });
		} catch (error) {
			await this.send(chatId, `列出会话失败：${esc(error instanceof Error ? error.message : error)}`);
		}
	}

	async openSession(chatId, sessionId) {
		try {
			const title = await this.ctx.sessionQuery.readTitle(sessionId);
			this.linkSession(chatId, sessionId);
			await this.send(chatId, `📍 当前会话已切换：<b>${esc(title || sessionId)}</b>\n<code>${esc(sessionId)}</code>\n现在可以直接发消息继续对话。`);
		} catch (error) {
			await this.send(chatId, `打开会话失败：${esc(error instanceof Error ? error.message : error)}`);
		}
	}

	/** Remember that a chat is linked to a session (events will push there). */
	linkSession(chatId, sessionId) {
		const record = this.chatRecord(chatId);
		record.current = sessionId;
		if (!record.linked.includes(sessionId)) record.linked.push(sessionId);
		this.state.sessions[sessionId] = chatId;
		this.knownSessions.add(sessionId);
		this.scheduleSave();
	}

	/** The primary chat linked to a session, if any. */
	linkedChat(sessionId) {
		const primary = this.state.sessions[sessionId];
		if (primary !== undefined) return primary;
		for (const [chatId, record] of Object.entries(this.state.chats)) {
			if (record.linked.includes(sessionId)) return Number(chatId);
		}
		return undefined;
	}

	async createSession(chatId, prompt) {
		try {
			const workspacePath = this.cfg.workspace.trim() || os.homedir();
			mkdirSync(workspacePath, { recursive: true });
			const workspace = await this.ctx.workspaceRegistry.create(workspacePath);
			const presetId = this.cfg.agentPreset;
			await this.ctx.agentPresets.resolve(presetId);
			await this.ctx.agentPresets.standingKeyFor(presetId);
			await this.ctx.permissionPresets.resolve(this.cfg.permissionPreset);
			const sessionId = `telegram-${randomUUID()}`;
			const selection = this.modelSelection();
			const handle = await this.ctx.agents.create({
				sessionId,
				meta: { cwd: workspace.path, agentPreset: presetId },
				agentOptions: { provider: selection.provider, model: selection.model },
				setup: async (agentCtx) => {
					await this.ctx.agentPresets.mount(agentCtx, presetId);
					if (this.cfg.modelId) this.installModelSelection(agentCtx, selection);
				}
			});
			await workspace.attachSession(sessionId);
			this.ctx.permissionPresets.set(handle.agent.session, this.cfg.permissionPreset);
			this.ctx.sessionTitle.rename(handle.agent.session, titleFromPrompt(prompt));
			this.linkSession(chatId, sessionId);
			handle.agent.followup(this.userMessage(prompt));
			await this.send(chatId, `🚀 已创建会话 <code>${esc(sessionId)}</code>，开始处理：\n<b>${esc(titleFromPrompt(prompt))}</b>\n\n后续消息会实时推送到这里。`);
		} catch (error) {
			this.ctx.logger.warn(`dsh-plugin-telegram: createSession failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
			await this.send(chatId, `创建会话失败：${esc(error instanceof Error ? error.message : error)}`);
		}
	}

	modelSelection() {
		const current = this.ctx.agentDefaultModel?.currentSelection?.() ?? {};
		return {
			provider: this.cfg.modelProvider || current.provider || "dsh",
			model: this.cfg.modelId || current.model || "deepseek/deepseek-v4-flash-0731"
		};
	}

	/** Force the configured model on the session's first request (webhook pattern). */
	installModelSelection(agentCtx, selection) {
		agentCtx.on("agent/request", async (_payload, next) => {
			const resolved = await next();
			const agent = agentCtx.agent;
			if (agent === undefined) return resolved;
			if (agent.session.requestHeader() !== undefined || resolved.provider !== selection.provider || resolved.model !== selection.model) return resolved;
			const { reasoningEffort: _inherited, ...without } = resolved;
			return without;
		});
	}

	userMessage(text) {
		return createUserMessage({
			content: [{ type: "text", text }],
			source: { kind: "plugin", plugin: name }
		});
	}

	/** Ensure the session has a live Agent, resuming it if needed. */
	async ensureLiveAgent(sessionId) {
		const live = this.ctx.agents.get(sessionId);
		if (live !== undefined) return live;
		const observation = await this.ctx.sessionQuery.observeSession(sessionId);
		const presetId = observation.header?.agentPreset ?? this.cfg.agentPreset;
		const selection = this.modelSelection();
		const { agent } = await this.ctx.agents.resume({
			resumeSessionId: sessionId,
			agentOptions: { provider: selection.provider, model: selection.model },
			setup: async (agentCtx) => {
				await this.ctx.agentPresets.mount(agentCtx, presetId);
				if (this.cfg.modelId) this.installModelSelection(agentCtx, selection);
			}
		});
		return agent;
	}

	async sendToSession(chatId, sessionId, prompt) {
		try {
			this.linkSession(chatId, sessionId);
			const agent = await this.ensureLiveAgent(sessionId);
			const message = this.userMessage(prompt);
			if (agent.status === "running" && typeof agent.inject === "function") {
				await agent.inject(message);
				await this.send(chatId, "📥 已注入到正在进行的回合。");
			} else {
				await agent.followup(message);
				await this.send(chatId, "📤 已提交。结果会推送到这里。");
			}
		} catch (error) {
			this.ctx.logger.warn(`dsh-plugin-telegram: sendToSession failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
			await this.send(chatId, `发送失败：${esc(error instanceof Error ? error.message : error)}`);
		}
	}

	async tailSession(chatId, sessionId, n) {
		try {
			this.linkSession(chatId, sessionId);
			const events = await this.ctx.sessionQuery.listEvents(sessionId);
			const seen = [];
			for (const event of events) {
				if (event.type === "user/message" || event.type === "assistant/message") {
					const text = event.type === "user/message"
						? contentText(event.data?.content)
						: contentText(event.data?.message?.content);
					if (!text) continue;
					seen.push({ type: event.type, text });
				}
			}
			if (seen.length === 0) {
				await this.send(chatId, "该会话还没有消息。");
				return;
			}
			const last = seen.slice(-n);
			const lines = last.map((item) => `${item.type === "user/message" ? "👤" : "🤖"} ${esc(truncate(item.text, 1200))}`);
			await this.send(chatId, `📜 <b>最近 ${last.length} 条</b>（<code>${esc(sessionId)}</code>）\n\n${lines.join("\n\n")}`);
		} catch (error) {
			await this.send(chatId, `读取历史失败：${esc(error instanceof Error ? error.message : error)}`);
		}
	}

	async statusSession(chatId, sessionId) {
		try {
			this.linkSession(chatId, sessionId);
			const agent = this.ctx.agents.get(sessionId);
			const title = await this.ctx.sessionQuery.readTitle(sessionId).catch(() => "");
			const events = await this.ctx.sessionQuery.listEvents(sessionId);
			let todos = [];
			for (const event of events) {
				if (event.type === "todo/write" && Array.isArray(event.data?.todos)) todos = event.data.todos;
			}
			const lines = [
				`📊 <b>会话状态</b>`,
				`<code>${esc(sessionId)}</code>`,
				title ? `<b>${esc(title)}</b>` : "",
				`状态：${agent ? (agent.status === "running" ? "🟢 运行中" : "⚪ 空闲") : "⚫ 未加载"}`,
				`事件数：${events.length}`,
				"",
				"<b>待办</b>",
				formatTodos(todos)
			];
			await this.send(chatId, lines.filter((l) => l !== "").join("\n"));
		} catch (error) {
			await this.send(chatId, `读取状态失败：${esc(error instanceof Error ? error.message : error)}`);
		}
	}

	// -------------------------------------------------------------- callbacks

	async onCallbackQuery(query) {
		const chatId = query.message?.chat?.id;
		const messageId = query.message?.message_id;
		if (chatId === undefined) return;
		if (!this.isAuthorized(chatId)) return;
		const data = query.data ?? "";

		if (data.startsWith("s:")) {
			const raw = data.slice(2);
			const sessionId = this.shortSessions.get(raw) ?? raw;
			await this.answerCallback(query.id, "已切换");
			await this.openSession(chatId, sessionId);
			return;
		}
		if (data.startsWith("a:")) {
			const [, pendingId, action] = data.split(":");
			const pending = this.pending.get(pendingId);
			if (pending === undefined || pending.kind !== "approval") {
				await this.answerCallback(query.id, "该审批已失效");
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(pendingId);
			const outcome = action === "1" ? "allowed-once" : "rejected";
			pending.resolve(outcome);
			await this.answerCallback(query.id, outcome === "allowed-once" ? "✅ 已允许" : "⛔ 已拒绝");
			await this.edit(chatId, pending.messageId, pending.baseText + `\n\n— ${outcome === "allowed-once" ? "✅ 已允许" : "⛔ 已拒绝"}（${query.from?.first_name ?? "手机"}）`);
			return;
		}
		if (data.startsWith("q:")) {
			const parts = data.split(":");
			const pendingId = parts[1];
			const optionIndex = Number.parseInt(parts[2], 10);
			const multi = parts[3] === "1";
			const pending = this.pending.get(pendingId);
			if (pending === undefined || pending.kind !== "question") {
				await this.answerCallback(query.id, "该提问已失效");
				return;
			}
			const question = pending.questions[0];
			if (!question) return;
			const option = question.options?.[optionIndex];
			if (!option) {
				await this.answerCallback(query.id, "选项无效");
				return;
			}
			if (multi) {
				// toggle selection for multi-select
				const key = pending.selected ?? [];
				const idx = key.indexOf(option.id);
				if (idx >= 0) key.splice(idx, 1);
				else key.push(option.id);
				pending.selected = key;
				await this.answerCallback(query.id, key.length ? `已选 ${key.length} 项` : "已清空");
				await this.renderQuestionMessage(pending);
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(pendingId);
			pending.resolve({ answers: [{ id: question.id, selected: [option.id] }] });
			await this.answerCallback(query.id, "✅ 已回答");
			await this.edit(chatId, pending.messageId, pending.baseText + `\n\n— ✅ 已选择：${esc(option.label)}`);
			return;
		}
		if (data.startsWith("qd:")) {
			const pendingId = data.slice(3);
			const pending = this.pending.get(pendingId);
			if (pending === undefined || pending.kind !== "question") {
				await this.answerCallback(query.id, "该提问已失效");
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(pendingId);
			const question = pending.questions[0];
			pending.resolve({ answers: [{ id: question?.id ?? "", selected: pending.selected ?? [] }] });
			const picked = (pending.selected ?? []).map((id) => question?.options?.find((o) => o.id === id)?.label ?? id);
			await this.answerCallback(query.id, picked.length ? `✅ 已提交 ${picked.length} 项` : "已提交（空）");
			await this.edit(chatId, pending.messageId, pending.baseText + `\n\n— ✅ 已提交${picked.length ? `：${esc(picked.join("、"))}` : ""}`);
			return;
		}
		if (data.startsWith("t:")) {
			const sessionId = data.slice(2);
			await this.answerCallback(query.id, "刷新中…");
			const events = await this.ctx.sessionQuery.listEvents(sessionId).catch(() => []);
			let todos = [];
			for (const event of events) {
				if (event.type === "todo/write" && Array.isArray(event.data?.todos)) todos = event.data.todos;
			}
			await this.edit(chatId, messageId, `📋 <b>待办</b>（<code>${esc(sessionId)}</code>）\n\n${esc(formatTodos(todos))}`, {
				reply_markup: { inline_keyboard: [[{ text: "🔄 刷新", callback_data: `t:${sessionId}` }]] }
			});
			return;
		}
		await this.answerCallback(query.id, "未知操作");
	}

	// ------------------------------------------------------------- DSH events

	onSessionCreated(session) {
		this.knownSessions.add(session.id);
	}

	onSessionDisposed(session) {
		this.turnMessages.delete(session.id);
		this.todoMessages.delete(session.id);
	}

	onSessionEvent(session, event) {
		const sessionId = session.id;
		const chatId = this.linkedChat(sessionId);
		if (chatId === undefined) return;
		try {
			switch (event.type) {
				case "user/message": {
					if (!this.cfg.notifyUserMessages) break;
					const source = event.data?.source;
					if (source?.kind === "plugin") break; // our own injected/followed messages
					const text = contentText(event.data?.content);
					if (!text) break;
					this.send(chatId, `👤 <b>${esc(truncate(text, 800))}</b>`).catch(() => {});
					break;
				}
				case "assistant/message": {
					if (!this.cfg.notifyAssistantMessages) break;
					const text = contentText(event.data?.message?.content);
					if (!text) break;
					this.send(chatId, `🤖 ${esc(truncate(text, this.cfg.maxMessageLength))}`).catch(() => {});
					break;
				}
				case "turn/start": {
					if (!this.cfg.notifyTurnSummary) break;
					this.sendTyping(chatId).catch(() => {});
					// record intent synchronously so a fast turn/end can still resolve it
					this.turnMessages.set(sessionId, { chatId, messageId: null });
					this.send(chatId, "⏳ DSH 正在处理…").then((sent) => {
						const entry = this.turnMessages.get(sessionId);
						if (entry !== undefined && sent?.message_id !== undefined) {
							entry.messageId = sent.message_id;
							this.turnMessages.set(sessionId, entry);
						}
					}).catch(() => {});
					break;
				}
				case "turn/end": {
					if (!this.cfg.notifyTurnSummary) break;
					const pending = this.turnMessages.get(sessionId);
					const reason = event.data?.reason ?? {};
					let summary;
					switch (reason.kind) {
						case "error":
							summary = `❌ 回合出错：${esc(truncate(reason.error?.message ?? "未知错误", 300))}`;
							break;
						case "aborted":
							summary = "⚠️ 回合已中止。";
							break;
						case "max-tokens":
							summary = "⚠️ 回合达到 token 上限。";
							break;
						case "interrupted":
							summary = "⏸ 回合被中断。";
							break;
						default:
							summary = "✅ 回合完成。";
					}
					if (pending !== undefined) {
						this.turnMessages.delete(sessionId);
						if (pending.messageId !== null) {
							this.edit(pending.chatId, pending.messageId, summary).catch(() => {});
						}
						// intent recorded but the "⏳" message never landed — drop the summary
						// (assistant messages already carry the actual content)
					} else {
						this.send(chatId, summary).catch(() => {});
					}
					break;
				}
				case "tool/call": {
					if (!this.cfg.notifyToolCalls) break;
					const name2 = event.data?.name ?? "tool";
					const args = String(event.data?.arguments ?? "").trim();
					const snippet = args.length > 150 ? `${args.slice(0, 150)}…` : args;
					this.send(chatId, `🔧 <code>${esc(name2)}</code> ${snippet ? `\n<code>${esc(snippet)}</code>` : ""}`).catch(() => {});
					break;
				}
				case "todo/write": {
					if (!this.cfg.notifyTodos) break;
					const todos = event.data?.todos;
					if (!Array.isArray(todos)) break;
					const text = `📋 <b>待办</b>\n\n${formatTodos(todos)}`;
					const markup = { reply_markup: { inline_keyboard: [[{ text: "🔄 刷新", callback_data: `t:${sessionId}` }]] } };
					const existing = this.todoMessages.get(sessionId);
					if (existing !== undefined) {
						this.edit(existing.chatId, existing.messageId, text, markup).catch(() => {
							this.todoMessages.delete(sessionId);
							this.send(chatId, text, markup).then((sent) => {
								if (sent?.message_id !== undefined) this.todoMessages.set(sessionId, { chatId, messageId: sent.message_id });
							}).catch(() => {});
						});
					} else {
						this.send(chatId, text, markup).then((sent) => {
							if (sent?.message_id !== undefined) this.todoMessages.set(sessionId, { chatId, messageId: sent.message_id });
						}).catch(() => {});
					}
					break;
				}
				default:
					break;
			}
		} catch (error) {
			this.ctx.logger.warn(`dsh-plugin-telegram: session/event ${event.type} handling failed: ${error instanceof Error ? error.message : error}`);
		}
	}

	// ------------------------------------------------------------- approvals

	onApproval(request, next) {
		if (!this.cfg.forwardApprovals) return next();
		const sessionId = request.agent?.session?.id;
		const chatId = this.linkedChat(sessionId);
		if (chatId === undefined) return next();
		return this.presentApproval(request, chatId).catch(() => next());
	}

	async presentApproval(request, chatId) {
		const sessionId = request.agent.session.id;
		const pendingId = shortId();
		const reason = request.reason ? String(request.reason) : "";
		const lines = [
			"🔐 <b>DSH 请求审批</b>",
			`会话：<code>${esc(sessionId)}</code>`,
			`工具：<code>${esc(request.toolName ?? "?")}</code>`,
			reason ? `原因：${esc(truncate(reason, 500))}` : "",
			"",
			"允许后仅对本次操作生效。"
		];
		const baseText = lines.filter(Boolean).join("\n");
		const sent = await this.send(chatId, baseText, {
			reply_markup: {
				inline_keyboard: [[
					{ text: "✅ 允许一次", callback_data: `a:${pendingId}:1` },
					{ text: "⛔ 拒绝", callback_data: `a:${pendingId}:0` }
				]]
			}
		});
		const messageId = sent?.message_id;

		return await new Promise((resolve) => {
			const pending = {
				key: pendingId,
				kind: "approval",
				resolve,
				chatId,
				messageId,
				sessionId,
				baseText
			};
			const timer = setTimeout(() => {
				if (this.pending.get(pendingId) !== pending) return;
				this.pending.delete(pendingId);
				this.edit(chatId, messageId, baseText + `\n\n— ⏰ 审批超时，已取消`).catch(() => {});
				resolve("cancelled");
			}, this.cfg.approvalTimeoutSeconds * 1000);
			pending.timer = timer;
			this.pending.set(pendingId, pending);

			if (request.signal?.aborted === true) {
				clearTimeout(timer);
				this.pending.delete(pendingId);
				resolve("cancelled");
				return;
			}
			request.signal?.addEventListener("abort", () => {
				if (this.pending.get(pendingId) !== pending) return;
				clearTimeout(timer);
				this.pending.delete(pendingId);
				this.edit(chatId, messageId, baseText + `\n\n— ⏹ 请求已取消`).catch(() => {});
				resolve("cancelled");
			}, { once: true });
		});
	}

	// -------------------------------------------------------------- questions

	onQuestion(request, next) {
		if (!this.cfg.forwardQuestions) return next();
		const sessionId = request.agent?.session?.id;
		const chatId = this.linkedChat(sessionId);
		if (chatId === undefined) return next();
		return this.presentQuestion(request, chatId).catch(() => next());
	}

	async presentQuestion(request, chatId) {
		const sessionId = request.agent?.session?.id;
		const pendingId = shortId();
		const questions = request.questions ?? [];

		const pending = {
			key: pendingId,
			kind: "question",
			questions,
			chatId,
			messageId: undefined,
			sessionId,
			baseText: "",
			selected: [],
			resolve: undefined,
			timer: undefined
		};

		const outcomePromise = new Promise((resolve) => {
			pending.resolve = resolve;
			const timer = setTimeout(() => {
				if (this.pending.get(pendingId) !== pending) return;
				this.pending.delete(pendingId);
				this.edit(chatId, pending.messageId, pending.baseText + `\n\n— ⏰ 提问超时，已跳过`).catch(() => {});
				resolve({ answers: questions.map((q) => ({ id: q.id, selected: [] })) });
			}, this.cfg.questionTimeoutSeconds * 1000);
			pending.timer = timer;
		});

		const first = questions[0];
		if (questions.length > 1 || first === undefined) {
			// multiple questions: forward them all with numbers; text reply answers in order (one per line)
			const lines = [
				"❓ <b>DSH 向你提问</b>",
				`会话：<code>${esc(sessionId ?? "?")}</code>`,
				"",
				...questions.map((q, i) => `${i + 1}. ${esc(q.question)}${q.options?.length ? `（选项：${q.options.map((o) => `${o.label}`).join(" / ")}）` : ""}`),
				"",
				"请回复对应答案（一行一个；或对单选项回复按钮）"
			];
			pending.baseText = lines.join("\n");
			const sent = await this.send(chatId, pending.baseText);
			pending.messageId = sent?.message_id;
			this.pending.set(pendingId, pending);
			return await outcomePromise;
		}

		// single question
		const question = first;
		const lines = [
			"❓ <b>DSH 向你提问</b>",
			`会话：<code>${esc(sessionId ?? "?")}</code>`,
			"",
			esc(question.question),
			question.options?.length ? "" : "（回复文字即可作答）"
		];
		pending.baseText = lines.filter(Boolean).join("\n");
		if (question.multiSelect === true) pending.baseText += "\n\n（多选：点选后按 提交）";

		const keyboard = [];
		if (question.options?.length) {
			const multi = question.multiSelect === true;
			question.options.forEach((option, index) => {
				keyboard.push([{ text: option.label, callback_data: `q:${pendingId}:${index}:${multi ? "1" : "0"}` }]);
			});
			if (multi) keyboard.push([{ text: "✅ 提交", callback_data: `qd:${pendingId}` }]);
		}

		const sent = await this.send(chatId, pending.baseText, keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {});
		pending.messageId = sent?.message_id;
		this.pending.set(pendingId, pending);

		if (!keyboard.length) {
			// no options: wait for a text reply; the reply-to flow resolves it
			return await outcomePromise;
		}
		return await outcomePromise;
	}

	async renderQuestionMessage(pending) {
		const question = pending.questions[0];
		if (!question) return;
		const picked = pending.selected ?? [];
		const keyboard = [];
		(question.options ?? []).forEach((option, index) => {
			const mark = picked.includes(option.id) ? "✅ " : "";
			keyboard.push([{ text: `${mark}${option.label}`, callback_data: `q:${pending.key}:${index}:1` }]);
		});
		keyboard.push([{ text: "✅ 提交", callback_data: `qd:${pending.key}` }]);
		let text = pending.baseText;
		if (picked.length) text += `\n\n已选：${picked.map((id) => question.options?.find((o) => o.id === id)?.label ?? id).join("、")}`;
		await this.edit(pending.chatId, pending.messageId, text, { reply_markup: { inline_keyboard: keyboard } });
	}

	async answerCustomQuestion(pending, text) {
		clearTimeout(pending.timer);
		this.pending.delete(pending.key);
		const answers = [];
		if (pending.questions.length === 1) {
			answers.push({ id: pending.questions[0].id, selected: [], custom: text });
		} else {
			const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
			pending.questions.forEach((q, i) => {
				answers.push({ id: q.id, selected: [], ...lines[i] !== undefined ? { custom: lines[i] } : {} });
			});
		}
		pending.resolve({ answers });
		await this.send(pending.chatId, "✅ 已收到回答。");
	}
}

export { apply, name, inject, Config };
