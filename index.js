import fs from "fs"
import path from "path"
const grammyPkgPath = path.resolve(process.cwd(), "node_modules/grammy/package.json")
const grammyVersion = JSON.parse(fs.readFileSync(grammyPkgPath, "utf-8")).version

import makeConfig from "../../lib/plugins/config.js"
import { Bot as GrammyBot, InputFile, InlineKeyboard, Keyboard } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { fileTypeFromBuffer } from "file-type";
import imageSize from "image-size";
import { autoRetry } from "@grammyjs/auto-retry";

process.env.NTBA_FIX_350 = 1

/**
 * Redis 缓存辅助函数：存储 callback_data 超长映射
 * @param {string} key - Redis 键
 * @param {string} value - 存储的值
 * @param {number} ttlSeconds - 过期时间（秒），默认 1 天
 * @returns {boolean}
 */
function tgRedisSet(key, value, ttlSeconds = 86400) {
    if (!global.redis) return false;
    try {
        return redis.set(key, value, "EX", ttlSeconds);
    } catch {
        return false;
    }
}

/**
 * Redis 缓存辅助函数：获取 callback_data 超长映射
 * @param {string} key - Redis 键
 * @returns {Promise<string|null>}
 */
async function tgRedisGet(key) {
    if (!global.redis) return null;
    try {
        return await redis.get(key);
    } catch {
        return null;
    }
}

/**
 * 生成短 ID（用于 callback_data 映射）
 * @param {string} prefix - ID 前缀
 * @returns {string}
 */
function tgMakeShortId(prefix = "tg") {
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 10);
    return `${prefix}_${ts}_${rnd}`;
}

/**
 * 编码 callback_data（超长数据使用 Redis 短 ID 映射）
 * 解决 TG callback_data 64 字节限制问题
 * @param {string} self_id - Bot ID
 * @param {string} payload - 原始 callback 数据
 * @returns {Promise<string>} - 编码后的 callback_data
 */
async function tgEncodeCallbackData(self_id, payload) {
    const buf = Buffer.from(String(payload), "utf8");
    if (buf.length <= 64) return String(payload);
    const shortId = tgMakeShortId("yzcb");
    const key = `Yz:tg:cb:${self_id}:${shortId}`;
    tgRedisSet(key, String(payload), 7 * 24 * 3600);
    return `__yzcb__:${shortId}`;
}

/**
 * 解码 callback_data（还原 Redis 短 ID 映射）
 * @param {string} self_id - Bot ID
 * @param {string} payload - 收到的 callback_data
 * @returns {Promise<string>} - 原始 callback 数据
 */
async function tgDecodeCallbackData(self_id, payload) {
    const s = String(payload || "");
    if (!s.startsWith("__yzcb__:")) return s;
    const shortId = s.slice("__yzcb__:".length);
    const key = `Yz:tg:cb:${self_id}:${shortId}`;
    return (await tgRedisGet(key)) || s;
}

/**
 * 生成 Redis 消息缓存键
 * @param {string} self_id - Bot ID
 * @param {number} chat_id - 聊天 ID
 * @param {number} message_id - 消息 ID
 * @returns {string}
 */
function tgMsgKey(self_id, chat_id, message_id) {
    return `Yz:tg:msg:${self_id}:${chat_id}:${message_id}`;
}

/**
 * 生成 Redis 聊天历史列表键
 * @param {string} self_id - Bot ID
 * @param {number} chat_id - 聊天 ID
 * @returns {string}
 */
function tgChatListKey(self_id, chat_id) {
    return `Yz:tg:chat:${self_id}:${chat_id}:messages`;
}

/**
 * 缓存消息到 Redis（用于 getMsg/getChatHistory 实现）
 * 由于 Bot API 无法拉取历史消息，通过缓存自己收发过的消息来提供近似功能
 * @param {string} self_id - Bot ID
 * @param {number} chat_id - 聊天 ID
 * @param {number} message_id - 消息 ID
 * @param {Object} msg - 消息内容
 */
async function tgCacheMessage(self_id, chat_id, message_id, msg) {
    if (!global.redis) return;
    try {
        const key = tgMsgKey(self_id, chat_id, message_id);
        await redis.set(key, JSON.stringify(msg), "EX", 7 * 24 * 3600);
        const listKey = tgChatListKey(self_id, chat_id);
        await redis.lPush(listKey, String(message_id));
        await redis.lTrim(listKey, 0, 199);
        await redis.expire(listKey, 7 * 24 * 3600);
    } catch {
    }
}

/**
 * 从 Redis 获取缓存消息
 * @param {string} self_id - Bot ID
 * @param {number} chat_id - 聊天 ID
 * @param {number} message_id - 消息 ID
 * @returns {Promise<Object|null>}
 */
async function tgGetCachedMessage(self_id, chat_id, message_id) {
    if (!global.redis) return null;
    try {
        const key = tgMsgKey(self_id, chat_id, message_id);
        const v = await redis.get(key);
        return v ? JSON.parse(v) : null;
    } catch {
        return null;
    }
}

/**
 * 从 Redis 获取聊天历史（近似实现）
 * 注意：只包含 Bot 运行期间缓存的消息
 * @param {string} self_id - Bot ID
 * @param {number} chat_id - 聊天 ID
 * @param {number} count - 获取条数，默认 20
 * @returns {Promise<Array>}
 */
async function tgGetCachedChatHistory(self_id, chat_id, count = 20) {
    if (!global.redis) return [];
    try {
        const listKey = tgChatListKey(self_id, chat_id);
        const ids = await redis.lRange(listKey, 0, Math.max(0, Number(count) - 1));
        const out = [];
        for (const mid of ids) {
            const msg = await tgGetCachedMessage(self_id, chat_id, mid);
            if (msg) out.push(msg);
        }
        return out;
    } catch {
        return [];
    }
}

logger.info(logger.yellow("- 正在加载 Telegram 适配器插件"))

const { config, configSave } = await makeConfig("Telegram", {
    tips: "",
    permission: "master",
    proxy: "",
    reverseProxy: "",
    token: [],
}, {
    tips: [
        "欢迎使用 trss-yunzai-telegram-adapter ! 作者：zhiyu1998  | 二改：rock8526652 & LBY123165",
        "参考：https://github.com/rock8526652/trss-yunzai-telegram-adapter/tree/new-dev",
    ],
})

/**
 * 构造 grammY 发送的文件类型
 * @param data {type: string, file: string, name: string}
 * @returns {Promise<{}>}
 */
async function constructFileType(data) {
    const file = {}
    // 构造 url 和 buffer
    if (Buffer.isBuffer(data.file)) {
        file.url = data.name || "Buffer"
        file.buffer = data.file
    } else {
        file.url = data.file.replace(/^base64:\/\/.*/, "base64://...")
        file.buffer = await Bot.Buffer(data.file);
    }
    if (Buffer.isBuffer(file.buffer)) {
        file.type = await fileTypeFromBuffer(file.buffer);
        const timestamp = Date.now().toString(36);
        const randomString = Math.random().toString(36).substring(2, 10);
        const extension = file.type?.ext; // 假设 file.type.ext 是文件的扩展名
        file.name ??= `${timestamp}.${randomString}.${extension}`;
    }
    return file;
}

/**
 * 格式化发送信息
 * @param ctx
 * @param fileInfo
 * @param text
 * @returns {string}
 */
function formatSendMessage(ctx, fileInfo = {} || [], text = "") {
    if (Array.isArray(fileInfo)) {
        return `[${ctx.id}] ${text} ${fileInfo.length} 个媒体文件`;
    } else {
        return `[${ctx.id}] ${text} ${fileInfo.name}(${fileInfo.url} ${(fileInfo.buffer.length / 1024).toFixed(2)}KB)`;
    }
}

/**
 * 适配器主类
 * 提供与 TRSS-Yunzai 框架的完整对接，支持消息收发、群管、按钮回调等功能
 */
const adapter = new class TelegramAdapter {
    constructor() {
        this.id = "Telegram"
        this.name = "TelegramBot"
        this.version = `GrammY v${grammyVersion}`
    }

    /**
     * 发送消息
     * @param ctx
     * @param msg
     * @param opts
     * @returns {Promise<{data: *[], message_id: *[]}>}
     */
    async sendMsg(ctx, msg, opts = {}) {
        const msgs = [];
        const message_id = [];
        let textParts = [];

        const sendText = async () => {
            const text = textParts.join("");
            if (!text) return;
            Bot.makeLog("info", `发送文本：[${ctx.id}] ${text}`, ctx.self_id);
            try {
                // 返回发送消息的信息
                const sendMsgInfo = await ctx.bot.api.sendMessage(ctx.id, text, opts);
                // 如果发送成功
                if (sendMsgInfo) {
                    msgs.push(sendMsgInfo);
                    if (sendMsgInfo.message_id) message_id.push(sendMsgInfo.message_id);
                    await tgCacheMessage(ctx.self_id, ctx.id, sendMsgInfo.message_id, {
                        message_id: sendMsgInfo.message_id,
                        chat_id: ctx.id,
                        self_id: ctx.self_id,
                        time: sendMsgInfo.date,
                        message: [{ type: "text", text }],
                        raw_message: text,
                    });
                    // 统计更新
                    ctx.bot.stat.sent_msg_cnt++;
                    if (global.redis) {
                        redis.incr(`Yz:count:send:msg:bot:${ctx.self_id}:total`);
                    }
                }
            } catch (error) {
                Bot.makeLog("error", `发送文本失败：[${ctx.id}] ${error.message}`, ctx.self_id);
                Bot.makeLog("error", `详细错误：${JSON.stringify(error.response?.body || error)}`, ctx.self_id);
            }
            textParts = [];
        };

        const sendMedia = async (file, sendFunc) => {
            try {
                const ret = await sendFunc(file);
                if (ret) {
                    msgs.push(ret);
                    if (ret.message_id) message_id.push(ret.message_id);
                    if (ret.message_id) {
                        await tgCacheMessage(ctx.self_id, ctx.id, ret.message_id, {
                            message_id: ret.message_id,
                            chat_id: ctx.id,
                            self_id: ctx.self_id,
                            time: ret.date,
                            message: [{ type: "file" }],
                        });
                    }
                    // 统计更新
                    ctx.bot.stat.sent_msg_cnt++;
                    ctx.bot.stat.sent_image_cnt++; // 目前只发图
                    if (global.redis) {
                        redis.incr(`Yz:count:send:msg:bot:${ctx.self_id}:total`);
                        redis.incr(`Yz:count:send:image:bot:${ctx.self_id}:total`);
                    }
                }
            } catch (error) {
                Bot.makeLog("error", `发送媒体失败：[${ctx.id}] ${error.message}`, ctx.self_id);
            }
        };

        /**
         * 处理策略
         * @type {{button: ((function(*): Promise<*>)|*), image: ((function(*): Promise<void>)|*), node: ((function(*): Promise<void>)|*), default: ((function(*): Promise<void>)|*), file: ((function(*): Promise<void>)|*), at: ((function(*): Promise<void>)|*), record: ((function(*): Promise<void>)|*), text: ((function(*): Promise<void>)|*), video: ((function(*): Promise<void>)|*), reply: ((function(*): Promise<void>)|*)}}
         */
        const handlers = {
            "text": async (i) => {
                textParts.push(i.text);
            },
            // 地理位置：{ type: "location", latitude, longitude, ... }
            "location": async (i) => {
                await sendText();
                const latitude = Number(i.latitude ?? i.lat);
                const longitude = Number(i.longitude ?? i.lng);
                if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
                    Bot.makeLog("error", `发送位置失败：[${ctx.id}] latitude/longitude 无效`, ctx.self_id);
                    return;
                }
                Bot.makeLog("info", `发送位置：[${ctx.id}] ${latitude},${longitude}`, ctx.self_id);
                await ctx.bot.api.sendLocation(ctx.id, latitude, longitude, opts);
            },
            // 联系人：{ type: "contact", phone_number, first_name, last_name }
            "contact": async (i) => {
                await sendText();
                const phone = i.phone_number || i.phone || "";
                const first = i.first_name || i.first || "";
                const last = i.last_name || i.last || "";
                if (!phone || !first) {
                    Bot.makeLog("error", `发送联系人失败：[${ctx.id}] phone_number/first_name 缺失`, ctx.self_id);
                    return;
                }
                Bot.makeLog("info", `发送联系人：[${ctx.id}] ${first} ${last} ${phone}`, ctx.self_id);
                await ctx.bot.api.sendContact(ctx.id, phone, first, { ...opts, last_name: last });
            },
            // 投票：{ type: "poll", question, options, is_anonymous, allows_multiple_answers }
            "poll": async (i) => {
                await sendText();
                const question = i.question || "";
                const options = Array.isArray(i.options) ? i.options : [];
                if (!question || options.length < 2) {
                    Bot.makeLog("error", `发送投票失败：[${ctx.id}] question/options 不合法`, ctx.self_id);
                    return;
                }
                Bot.makeLog("info", `发送投票：[${ctx.id}] ${question}`, ctx.self_id);
                await ctx.bot.api.sendPoll(ctx.id, question, options, {
                    ...opts,
                    is_anonymous: i.is_anonymous ?? true,
                    allows_multiple_answers: i.allows_multiple_answers ?? false,
                });
            },
            // 骰子：{ type: "dice", emoji }
            "dice": async (i) => {
                await sendText();
                const emoji = i.emoji;
                Bot.makeLog("info", `发送骰子：[${ctx.id}] ${emoji || ""}`, ctx.self_id);
                await ctx.bot.api.sendDice(ctx.id, { ...opts, emoji });
            },
            "audio": async (i) => {
                await handlers.record(i);
            },
            "image": async (i) => {
                await sendText();
                const file = await constructFileType(i);
                // 如果无法识别文件类型就中断
                if (file.type === undefined) {
                    Bot.makeLog("error", "无法识别文件类型：" + file.url, ctx.self_id);
                    return;
                }

                Bot.makeLog("info", `发送图片：${formatSendMessage(ctx, file)}`, ctx.self_id);
                const size = imageSize(file.buffer);
                const sendFunc = size.height > 1280 || size.width > 1280
                    ? () => ctx.bot.api.sendDocument(ctx.id, new InputFile(file.buffer, file.name), opts)
                    : () => ctx.bot.api.sendPhoto(ctx.id, new InputFile(file.buffer, file.name), opts);
                await sendMedia(file, sendFunc);
            },
            "record": async (i) => {
                await sendText();
                const file = await constructFileType(i);
                // 如果无法识别文件类型就中断
                if (file.type === undefined) {
                    Bot.makeLog("error", "无法识别文件类型：" + file.url, ctx.self_id);
                    return;
                }

                Bot.makeLog("info", `发送音频：${formatSendMessage(ctx, file)}`, ctx.self_id);
                const audioFuncs = {
                    "mp3": () => ctx.bot.api.sendAudio(ctx.id, new InputFile(file.buffer, file.name), opts),
                    "m4a": () => ctx.bot.api.sendAudio(ctx.id, new InputFile(file.buffer, file.name), opts),
                    "opus": () => ctx.bot.api.sendVoice(ctx.id, new InputFile(file.buffer, file.name), opts),
                };
                const sendFunc = audioFuncs[file.type.ext] || (() => ctx.bot.api.sendDocument(ctx.id, new InputFile(file.buffer, file.name), opts));
                await sendMedia(file, sendFunc);
            },
            "sticker": async (i) => {
                await sendText();
                const file = await constructFileType(i);
                if (file.type === undefined) {
                    Bot.makeLog("error", "无法识别文件类型：" + file.url, ctx.self_id);
                    return;
                }
                Bot.makeLog("info", `发送贴纸：${formatSendMessage(ctx, file)}`, ctx.self_id);
                await sendMedia(file, () => ctx.bot.api.sendSticker(ctx.id, new InputFile(file.buffer, file.name), opts));
            },
            "animation": async (i) => {
                await sendText();
                const file = await constructFileType(i);
                if (file.type === undefined) {
                    Bot.makeLog("error", "无法识别文件类型：" + file.url, ctx.self_id);
                    return;
                }
                Bot.makeLog("info", `发送动图：${formatSendMessage(ctx, file)}`, ctx.self_id);
                await sendMedia(file, () => ctx.bot.api.sendAnimation(ctx.id, new InputFile(file.buffer, file.name), opts));
            },
            "video": async (i) => {
                await sendText();
                const file = await constructFileType(i);
                // 如果无法识别文件类型就中断
                if (file.type === undefined) {
                    Bot.makeLog("error", "无法识别文件类型：" + file.url, ctx.self_id);
                    return;
                }

                Bot.makeLog("info", `发送视频：${formatSendMessage(ctx, file)}`, ctx.self_id);
                await sendMedia(file, () => ctx.bot.api.sendVideo(ctx.id, new InputFile(file.buffer, file.name), opts));
            },
            "file": async (i) => {
                await sendText();
                const file = await constructFileType(i);
                // 如果无法识别文件类型就中断
                if (file.type === undefined) {
                    Bot.makeLog("error", "无法识别文件类型：" + file.url, ctx.self_id);
                    return;
                }

                Bot.makeLog("info", `发送文件：${formatSendMessage(ctx, file)}`, ctx.self_id);
                await sendMedia(file, () => ctx.bot.api.sendDocument(ctx.id, new InputFile(file.buffer, file.name), opts));
            },
            "reply": async (i) => {
                opts.reply_to_message_id = i.id;
            },
            "at": async (i) => {
                try {
                    const info = await ctx.bot.pickFriend(i.qq).getInfo();
                    if (info.username) {
                        textParts.push(`@${info.username}`);
                    } else {
                        textParts.push(i.text || i.name || `@${i.qq}`);
                    }
                } catch (e) {
                    textParts.push(i.text || i.name || `@${i.qq}`);
                }
            },
            "node": async (i) => {
                for (const ret of await Bot.sendForwardMsg(msg => this.sendMsg(ctx, msg), i.data)) {
                    msgs.push(...ret.data);
                    message_id.push(...ret.message_id);
                }
            },
            "button": async (i) => {
                if (i.layout === "remove") {
                    opts.reply_markup = { remove_keyboard: true };
                    return;
                }
                const isReply = i.layout === "reply";
                const keyboard = isReply ? new Keyboard() : new InlineKeyboard();
                const btnData = i?.data ?? i?.buttons ?? [];
                const rows = Array.isArray(btnData?.[0]) ? btnData : [btnData];

                for (const row of rows) {
                    for (const btn of row) {
                        if (isReply) {
                            // 底部按鈕 (Reply Keyboard)
                            if (btn.contact) {
                                keyboard.requestContact(btn.text);
                            } else if (btn.location) {
                                keyboard.requestLocation(btn.text);
                            } else if (btn.poll) {
                                keyboard.requestPoll(btn.text, btn.poll);
                            } else if (btn.webApp) {
                                keyboard.webApp(btn.text, btn.webApp);
                            } else {
                                keyboard.text(btn.text);
                            }
                        } else {
                            // 內嵌按鈕 (Inline Keyboard)
                            if (btn.link) {
                                keyboard.url(btn.text, btn.link);
                            } else if (btn.input) {
                                keyboard.switchInlineCurrent(btn.text, String(btn.input));
                            } else if (btn.callback || btn.data) {
                                const encoded = await tgEncodeCallbackData(ctx.self_id, btn.callback || btn.data);
                                keyboard.text(btn.text, encoded);
                            }
                        }
                    }
                    keyboard.row();
                }

                if (isReply) {
                    if (i.resized !== false) keyboard.resized(); // 默认开启 resized，否则按钮太大
                    if (i.persistent) keyboard.persistent();
                    if (i.oneTime) keyboard.oneTime();
                }

                opts.reply_markup = keyboard;
            },
            "default": async (i) => {
                textParts.push(JSON.stringify(i));
            }
        };

        /**
         * 发送处理
         * @returns {Promise<void>}
         */
        const sendHandler = async (messages) => {
            // 构造一文一图的情况，如果出现两张都是图片则给予后续逻辑处理
            if (Array.isArray(messages) && messages?.type !== 'node') {
                // 找出媒体、文字和其他特殊段（如 reply, at, button）
                const mediaAndOthers = { media: [], others: '', reply: null };
                for (const item of messages) {
                    if (typeof item === "object") {
                        if (item.type === "reply") {
                            mediaAndOthers.reply = item;
                            opts.reply_to_message_id = item.id;
                        } else if (item.type === "at") {
                            // 暂时不处理 at 转换，由后续 sendText/sendMessage 自然处理或者转换用户名
                            mediaAndOthers.others += ` @${item.qq} `;
                        } else if (item.type === "button") {
                            await handlers.button(item); // 配合 async-await 调用
                        } else {
                            mediaAndOthers.media.push(item);
                        }
                    } else {
                        mediaAndOthers.others += item;
                    }
                }
                // 判断是否有媒体，没有就发送文字，有就图文并茂
                if (mediaAndOthers.media.length === 1) {
                    const singleMedia = mediaAndOthers.media[0];
                    // 单个媒体和文字
                    const file = await constructFileType(singleMedia);
                    const type = singleMedia.type;
                    const captionOpts = { ...opts, caption: mediaAndOthers.others };
                    if (type === "video") {
                        await ctx.bot.api.sendVideo(ctx.id, new InputFile(file.buffer, file.name), captionOpts);
                    } else if (type === "file") {
                        await ctx.bot.api.sendDocument(ctx.id, new InputFile(file.buffer, file.name), captionOpts);
                    } else if (type === "record" || type === "audio") {
                        await ctx.bot.api.sendAudio(ctx.id, new InputFile(file.buffer, file.name), captionOpts);
                    } else if (type === "animation") {
                        await ctx.bot.api.sendAnimation(ctx.id, new InputFile(file.buffer, file.name), captionOpts);
                    } else {
                        await ctx.bot.api.sendPhoto(ctx.id, new InputFile(file.buffer, file.name), captionOpts);
                    }
                    // 打印日志
                    Bot.makeLog("info", `发送媒体组：${formatSendMessage(ctx, file, mediaAndOthers.others)}`, ctx.self_id);
                    // 统计更新
                    ctx.bot.stat.sent_msg_cnt++;
                    ctx.bot.stat.sent_image_cnt++;
                    if (global.redis) {
                        redis.incr(`Yz:count:send:msg:bot:${ctx.self_id}:total`);
                        redis.incr(`Yz:count:send:image:bot:${ctx.self_id}:total`);
                    }
                } else if (mediaAndOthers.media.length >= 2) {
                    // 出现多个媒体和文字
                    const mediaCollection = [];
                    // 这里比较复杂，需要将第一个media加入caption，其余正常处理成Group即可
                    for (let i = 0; i < mediaAndOthers.media.length; i++) {
                        const file = await constructFileType(mediaAndOthers.media[i]);
                        const t = mediaAndOthers.media[i].type;
                        const mType = t === "video" ? "video" : (t === "file" ? "document" : "photo");
                        const constructMedia = { type: mType, media: new InputFile(file.buffer, file.name) }
                        if (i === 0) {
                            constructMedia.caption = mediaAndOthers.others; // 仅在第一个文件中添加 caption
                        }
                        mediaCollection.push(constructMedia);
                    }
                    await ctx.bot.api.sendMediaGroup(ctx.id, mediaCollection, opts);
                    // 打印日志
                    Bot.makeLog("info", `发送媒体组：${formatSendMessage(ctx, mediaAndOthers.media, mediaAndOthers.others)}`, ctx.self_id);
                    // 统计更新
                    ctx.bot.stat.sent_msg_cnt++;
                    ctx.bot.stat.sent_image_cnt += mediaAndOthers.media.length;
                    if (global.redis) {
                        redis.incr(`Yz:count:send:msg:bot:${ctx.self_id}:total`);
                        for (let i = 0; i < mediaAndOthers.media.length; i++) {
                            redis.incr(`Yz:count:send:image:bot:${ctx.self_id}:total`);
                        }
                    }
                } else {
                    // 没有媒体和文字
                    await ctx.bot.api.sendMessage(ctx.id, mediaAndOthers.others, opts);
                    Bot.makeLog("info", `发送文本：${mediaAndOthers.others}`, ctx.self_id);
                    // 统计更新
                    ctx.bot.stat.sent_msg_cnt++;
                    if (global.redis) {
                        redis.incr(`Yz:count:send:msg:bot:${ctx.self_id}:total`);
                    }
                }
                return;
            } else if (Array.isArray(messages?.data) && messages?.type === 'node') {
                const messagesData = messages.data;
                // 过滤图片和视频合并发送
                const others = [];
                let mediaCollection = [];
                // 这里是构造 mediaCollection
                for (const item of messagesData) {
                    const singleMessage = item.message;
                    if (singleMessage.type === "image") {
                        const file = await constructFileType(singleMessage);
                        mediaCollection.push({ type: 'photo', media: new InputFile(file.buffer, file.name) });
                    } else if (singleMessage.type === "video") {
                        const file = await constructFileType(singleMessage);
                        mediaCollection.push({ type: 'video', media: new InputFile(file.buffer, file.name) });
                    } else {
                        others.push(item.message);
                    }
                }
                // 不是媒体的信息先发送
                for (let i of others) {
                    const handler = handlers[i.type] || handlers["default"];
                    await handler(i);
                }
                // 使用批处理避开 TG API 限制，经过测试限制为10张
                if (mediaCollection.length > 10) {
                    for (let i = 0; i < mediaCollection.length; i += 10) {
                        const batch = mediaCollection.slice(i, i + 10);
                        await ctx.bot.api.sendMediaGroup(ctx.id, batch);
                    }
                } else {
                    // 发送媒体
                    mediaCollection.length > 0 && (await ctx.bot.api.sendMediaGroup(ctx.id, mediaCollection));
                }
                // 打印日志
                Bot.makeLog("info", `发送媒体组：${formatSendMessage(ctx, mediaCollection)}`, ctx.self_id);
                return;
            }
            // 其他情况直接发送（理论上是单个消息处理）
            typeof messages !== 'object' && (messages = { type: 'text', text: messages });
            const handler = handlers[messages.type] || handlers["default"];
            await handler(messages);
        };
        // 发送处理
        await sendHandler(msg);

        await sendText();
        return { data: msgs, message_id };
    }

    /**
     * 撤回消息
     * @param data
     * @param message_id
     * @param opts
     * @returns {Promise<*[]>}
     */
    async recallMsg(data, message_id, opts) {
        Bot.makeLog("info", `撤回消息：[${data.id}] ${message_id}`, data.self_id)
        if (!Array.isArray(message_id))
            message_id = [message_id]
        const msgs = []
        for (const i of message_id)
            msgs.push(await data.bot.api.deleteMessage(data.id, i, opts))
        return msgs
    }

    /**
     * 编辑消息文本（配合 Inline Keyboard 回调使用）
     * @param data - 包含 bot, id (chat_id), self_id
     * @param message_id - 要编辑的消息 ID
     * @param text - 新的文本内容
     * @param opts - 可选参数，如 reply_markup (InlineKeyboard)
     */
    async editMsg(data, message_id, text, opts = {}) {
        Bot.makeLog("info", `编辑消息：[${data.id || data.chat_id || ''}] ${message_id}`, data.self_id)
        try {
            // 处理按钮中的 callback -> callback_data (如果插件传了 callback)
            if (opts.reply_markup && Array.isArray(opts.reply_markup.inline_keyboard)) {
                for (let row of opts.reply_markup.inline_keyboard) {
                    for (let btn of row) {
                        if (btn.callback && !btn.callback_data) {
                            btn.callback_data = await tgEncodeCallbackData(data.self_id, btn.callback);
                            delete btn.callback;
                        }
                        if (btn.data && !btn.callback_data) {
                            btn.callback_data = await tgEncodeCallbackData(data.self_id, btn.data);
                            delete btn.data;
                        }
                        if (btn.link && !btn.url) {
                            btn.url = btn.link;
                            delete btn.link;
                        }
                    }
                }
            }
            return await data.bot.api.editMessageText(data.id, message_id, text, opts)
        } catch (error) {
            Bot.makeLog("error", `编辑消息失败：[${data.id}] ${error.message}`, data.self_id)
        }
    }

    /**
     * 获取机器人头像
     * @param ctx
     * @returns {Promise<boolean|string>}
     */
    async getAvatarUrl(ctx) {
        try {
            // 获取机器人自身的信息
            const me = await ctx.bot.api.getMe();
            // 获取头像
            const photos = await ctx.bot.api.getUserProfilePhotos(me.id);
            // 制作成URL
            const fileId = photos.photos[0][0].file_id;
            const file = await ctx.bot.api.getFile(fileId);
            return `https://api.telegram.org/file/bot${ctx.bot.token}/${file.file_path}`;
        } catch (err) {
            logger.error(`获取头像错误：${logger.red(err)}`)
            return false
        }
    }

    /**
     * 获取好友信息
     * @param id
     * @param user_id
     * @returns {{getAvatarUrl: (function(): Promise<boolean|string>), recallMsg: (function(*, *): Promise<*[]>), getInfo: (function(): Promise<import("@grammyjs/types/manage.js").ChatFullInfo>), bot: *, self_id: *, id: *, sendMsg: (function(*, *): Promise<{data: *[], message_id: *[]}>)}}
     */
    pickFriend(id, user_id) {
        if (typeof user_id !== "string")
            user_id = String(user_id)
        const i = {
            ...Bot[id].fl.get(user_id),
            self_id: id,
            bot: Bot[id],
            id: user_id.replace(/^tg_/, ""),
        }
        return {
            ...i,
            sendMsg: (msg, opts) => this.sendMsg(i, msg, opts),
            recallMsg: (message_id, opts) => this.recallMsg(i, message_id, opts),
            editMsg: (message_id, text, opts) => this.editMsg(i, message_id, text, opts),
            getMsg: (message_id) => tgGetCachedMessage(id, i.id, message_id),
            getChatHistory: (message_seq, count) => tgGetCachedChatHistory(id, i.id, count),
            getForwardMsg: (message_id) => tgGetCachedMessage(id, i.id, message_id),
            getInfo: () => i.bot.api.getChat(i.id),
            getAvatarUrl: () => this.getAvatarUrl(i),
        }
    }

    /**
     * 获取成员信息
     * @param id
     * @param group_id
     * @param user_id
     * @returns {*&{getInfo: (function(): Promise<import("@grammyjs/types/manage.js").ChatMember>), group_id: *, user_id: *, bot: *, self_id: *}}
     */
    pickMember(id, group_id, user_id) {
        if (typeof group_id !== "string")
            group_id = String(group_id)
        if (typeof user_id !== "string")
            user_id = String(user_id)
        const i = {
            ...Bot[id].fl.get(user_id),
            self_id: id,
            bot: Bot[id],
            group_id: group_id.replace(/^tg_/, ""),
            user_id: user_id.replace(/^tg_/, ""),
        }
        return {
            ...this.pickFriend(id, user_id),
            ...i,
            getInfo: () => i.bot.api.getChatMember(i.group_id, i.user_id),
            // 群管 API
            get is_admin() {
                return (async () => {
                    const info = await i.bot.api.getChatMember(i.group_id, i.user_id);
                    return info.status === "administrator" || info.status === "creator";
                })();
            },
            get is_owner() {
                return (async () => {
                    const info = await i.bot.api.getChatMember(i.group_id, i.user_id);
                    return info.status === "creator";
                })();
            },
            setAdmin: (isAdmin = true) => {
                if (isAdmin) {
                    return i.bot.api.promoteChatMember(i.group_id, i.user_id, {
                        can_manage_chat: true,
                        can_delete_messages: true,
                        can_manage_video_chats: true,
                        can_restrict_members: true,
                        can_promote_members: false,
                        can_change_info: true,
                        can_invite_users: true,
                        can_pin_messages: true,
                    });
                } else {
                    return i.bot.api.promoteChatMember(i.group_id, i.user_id, {
                        can_manage_chat: false,
                        can_delete_messages: false,
                        can_manage_video_chats: false,
                        can_restrict_members: false,
                        can_promote_members: false,
                        can_change_info: false,
                        can_invite_users: false,
                        can_pin_messages: false,
                    });
                }
            },
            setTitle: (title) => i.bot.api.setChatAdministratorCustomTitle(i.group_id, i.user_id, title),
            mute: async (duration = 60) => {
                const until = Math.floor(Date.now() / 1000) + duration;
                return i.bot.api.restrictChatMember(i.group_id, i.user_id, {
                    can_send_messages: false,
                    until_date: until,
                });
            },
            unmute: () => {
                return i.bot.api.restrictChatMember(i.group_id, i.user_id, {
                    can_send_messages: true,
                    can_send_media_messages: true,
                    can_send_other_messages: true,
                    can_add_web_page_previews: true,
                });
            },
            kick: () => i.bot.api.banChatMember(i.group_id, i.user_id, { until_date: 0 }),
            ban: (duration = 0) => i.bot.api.banChatMember(i.group_id, i.user_id, { until_date: duration }),
            unban: () => i.bot.api.unbanChatMember(i.group_id, i.user_id),
        }
    }

    /**
     * 获取群信息
     * @param id
     * @param group_id
     * @returns {{getAvatarUrl: (function(): Promise<boolean|string>), pickMember: (function(*): *), recallMsg: (function(*, *): Promise<*[]>), getInfo: (function(): Promise<import("@grammyjs/types/manage.js").ChatFullInfo>), bot: *, self_id: *, id: *, sendMsg: (function(*, *): Promise<{data: *[], message_id: *[]}>)}}
     */
    pickGroup(id, group_id) {
        if (typeof group_id !== "string")
            group_id = String(group_id)
        const i = {
            ...Bot[id].gl.get(group_id),
            self_id: id,
            bot: Bot[id],
            id: group_id.replace(/^tg_/, ""),
        }
        return {
            ...i,
            sendMsg: (msg, opts) => this.sendMsg(i, msg, opts),
            recallMsg: (message_id, opts) => this.recallMsg(i, message_id, opts),
            editMsg: (message_id, text, opts) => this.editMsg(i, message_id, text, opts),
            getMsg: (message_id) => tgGetCachedMessage(id, i.id, message_id),
            getChatHistory: (message_seq, count) => tgGetCachedChatHistory(id, i.id, count),
            getForwardMsg: (message_id) => tgGetCachedMessage(id, i.id, message_id),
            getInfo: () => i.bot.api.getChat(i.id),
            getAvatarUrl: () => this.getAvatarUrl(i),
            pickMember: user_id => this.pickMember(id, i.id, user_id),
            // 群管 API
            setAvatar: (file) => i.bot.api.setChatPhoto(i.id, new InputFile(file)),
            setPermissions: (permissions) => i.bot.api.setChatPermissions(i.id, permissions),
            setSlowMode: (delay) => i.bot.api.setChatSlowModeDelay(i.id, delay),
            getInviteLink: () => i.bot.api.exportChatInviteLink(i.id),
            createInviteLink: (opts = {}) => i.bot.api.createChatInviteLink(i.id, opts),
            editInviteLink: (link, opts = {}) => i.bot.api.editChatInviteLink(i.id, link, opts),
            revokeInviteLink: (link) => i.bot.api.revokeChatInviteLink(i.id, link),
            setName: (title) => i.bot.api.setChatTitle(i.id, title),
            setDescription: (description) => i.bot.api.setChatDescription(i.id, description),
            muteMember: (user_id, duration = 60) => this.pickMember(id, i.id, user_id).mute(duration),
            unmuteMember: (user_id) => this.pickMember(id, i.id, user_id).unmute(),
            kickMember: (user_id) => this.pickMember(id, i.id, user_id).kick(),
            banMember: (user_id, duration = 0) => this.pickMember(id, i.id, user_id).ban(duration),
            unbanMember: (user_id) => this.pickMember(id, i.id, user_id).unban(),
            pinMessage: (message_id) => i.bot.api.pinChatMessage(i.id, message_id),
            unpinMessage: (message_id) => message_id ? i.bot.api.unpinChatMessage(i.id, message_id) : i.bot.api.unpinAllChatMessages(i.id),
            leave: () => i.bot.api.leaveChat(i.id),
            getMemberCount: () => i.bot.api.getChatMemberCount(i.id),
            // 入群申请处理（对应 chat_join_request -> request.group.add）
            approveJoinRequest: (user_id) => {
                const uid = String(user_id).replace(/^tg_/, "");
                return i.bot.api.approveChatJoinRequest(i.id, uid);
            },
            declineJoinRequest: (user_id) => {
                const uid = String(user_id).replace(/^tg_/, "");
                return i.bot.api.declineChatJoinRequest(i.id, uid);
            },
        }
    }

    /**
     * 解析 TG entities 为统一消息段
     * @param text {string}
     * @param entities {Array}
     * @returns {Array}
     */
    parseEntities(text, entities) {
        const segments = [];
        let lastOffset = 0;

        // 按 offset 排序
        const sorted = [...entities].sort((a, b) => a.offset - b.offset);

        for (const ent of sorted) {
            // 处理 entity 之前的普通文本
            if (ent.offset > lastOffset) {
                segments.push({
                    type: "text",
                    text: text.slice(lastOffset, ent.offset)
                });
            }

            const content = text.slice(ent.offset, ent.offset + ent.length);

            switch (ent.type) {
                case "mention":
                case "text_mention":
                    segments.push({
                        type: "at",
                        qq: ent.user ? `tg_${ent.user.id}` : content.replace(/^@/, ""),
                        name: content.replace(/^@/, "")
                    });
                    break;
                case "url":
                case "text_link":
                    segments.push({
                        type: "url",
                        url: ent.url || content,
                        text: content
                    });
                    break;
                case "bold":
                    segments.push({ type: "bold", text: content });
                    break;
                case "italic":
                    segments.push({ type: "italic", text: content });
                    break;
                case "code":
                    segments.push({ type: "code", text: content });
                    break;
                case "pre":
                    segments.push({ type: "pre", text: content, language: ent.language });
                    break;
                case "underline":
                    segments.push({ type: "underline", text: content });
                    break;
                case "strikethrough":
                    segments.push({ type: "strikethrough", text: content });
                    break;
                case "spoiler":
                    segments.push({ type: "spoiler", text: content });
                    break;
                default:
                    segments.push({ type: "text", text: content });
            }

            lastOffset = ent.offset + ent.length;
        }

        // 处理剩余的普通文本
        if (lastOffset < text.length) {
            segments.push({
                type: "text",
                text: text.slice(lastOffset)
            });
        }

        return segments;
    }

    /**
     * 制作适配器消息的内容（核心，需要把这个写好）
     * @param ctx 格莱美的上下文
     */
    makeMessage(ctx) {
        // 创建一个对象进行 bot 浅拷贝
        const data = {};

        data.bot = Bot[ctx.self_id];
        data.self_id = ctx.self_id;
        data.post_type = "message";
        data.user_id = `tg_${ctx.from.id}`
        data.sender = {
            user_id: data.user_id,
            nickname: ctx.from.first_name || ctx.from.username || "Unknown",
            is_bot: !!ctx.from.is_bot,
        }
        data.is_bot = !!ctx.from.is_bot;
        data.bot.fl.set(data.user_id, { ...ctx.from, ...data.sender })
        data.message_type = ctx.chat.type === "supergroup" ? "group" : ctx.chat.type;
        data.message = [];
        data.message_id = ctx.message.message_id;
        data.id = ctx.chat.id;
        data.entities = ctx.message.entities || ctx.message.caption_entities || [];
        data.reply = (msg, clear = false, opts = {}) => {
            const reply_id = Array.isArray(data.message_id) ? data.message_id[0] : data.message_id;
            return this.sendMsg(data, msg, { ...opts, clear_history: clear, reply_to_message_id: reply_id })
        }
        data.raw_message = "";
        data.is_forward = !!(ctx.message.forward_origin || ctx.message.forward_from || ctx.message.forward_from_chat);

        const replyTo = ctx.message.reply_to_message;
        if (replyTo?.message_id) {
            data.message.push({ type: "reply", id: replyTo.message_id, text: replyTo.text || replyTo.caption || "" });
        }

        // 消息内容 (普通文本)
        const text = ctx.message.text || ctx.message.caption || ""
        if (text) {
            // 解析 entities 生成结构化消息段
            const entities = ctx.message.entities || ctx.message.caption_entities || [];
            if (entities.length > 0) {
                // 按 offset 排序并解析
                const parsedSegments = this.parseEntities(text, entities);
                data.message.push(...parsedSegments);
            } else {
                data.message.push({ type: "text", text: text });
            }
            data.raw_message += text;
        }

        // 媒体内容处理
        if (ctx.message.photo) {
            const photo = ctx.message.photo[ctx.message.photo.length - 1]
            data.message.push({ type: "image", file_id: photo.file_id, file_unique_id: photo.file_unique_id })
        } else if (ctx.message.sticker) {
            data.message.push({ type: "sticker", file_id: ctx.message.sticker.file_id })
        } else if (ctx.message.video) {
            data.message.push({ type: "video", file_id: ctx.message.video.file_id })
        } else if (ctx.message.voice) {
            data.message.push({ type: "record", file_id: ctx.message.voice.file_id })
        } else if (ctx.message.audio) {
            data.message.push({ type: "audio", file_id: ctx.message.audio.file_id })
        } else if (ctx.message.document) {
            data.message.push({ type: "file", file_id: ctx.message.document.file_id, file_name: ctx.message.document.file_name })
        } else if (ctx.message.animation) {
            data.message.push({ type: "animation", file_id: ctx.message.animation.file_id })
        } else if (ctx.message.location) {
            // 地理位置
            data.message.push({
                type: "location",
                latitude: ctx.message.location.latitude,
                longitude: ctx.message.location.longitude,
            })
        } else if (ctx.message.contact) {
            // 联系人
            data.message.push({
                type: "contact",
                phone_number: ctx.message.contact.phone_number,
                first_name: ctx.message.contact.first_name,
                last_name: ctx.message.contact.last_name,
                user_id: ctx.message.contact.user_id ? `tg_${ctx.message.contact.user_id}` : undefined,
            })
        } else if (ctx.message.poll) {
            // 投票（注意：Bot API 下 poll 更新还有 poll_answer，这里只处理消息里自带的 poll）
            data.message.push({
                type: "poll",
                id: ctx.message.poll.id,
                question: ctx.message.poll.question,
                options: (ctx.message.poll.options || []).map(o => o.text),
                is_anonymous: ctx.message.poll.is_anonymous,
                allows_multiple_answers: ctx.message.poll.allows_multiple_answers,
            })
        } else if (ctx.message.dice) {
            // 骰子/游戏表情
            data.message.push({
                type: "dice",
                emoji: ctx.message.dice.emoji,
                value: ctx.message.dice.value,
            })
        }

        // 消息制作
        if (ctx.from.id === ctx.chat.id) {
            // 制作私发消息
            Bot.makeLog("info", `好友消息：[${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)
            data.friend = data.bot.pickFriend(data.user_id);
        } else {
            // 制作群消息
            const groupMessage = ctx.update.message;
            data.group_id = `tg_${groupMessage.chat.id}`
            data.group_name = `${groupMessage.chat.title || ''}${groupMessage.chat.username ? '-' + groupMessage.chat.username : ''}`
            data.bot.gl.set(groupMessage.chat.id, {
                ...groupMessage.chat,
                group_id: data.group_id,
                group_name: data.group_name,
            })
            // 制作完成，打印
            Bot.makeLog("info", `群消息：[${data.group_name}(${data.group_id}), ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, data.self_id)
            data.group = data.bot.pickGroup(data.group_id);
        }

        // 统计更新
        data.bot.stat.recv_msg_cnt++
        if (global.redis) {
            redis.incr(`Yz:count:receive:msg:bot:${data.self_id}:total`)
        }

        tgCacheMessage(ctx.self_id, ctx.chat.id, ctx.message.message_id, {
            message_id: ctx.message.message_id,
            chat_id: ctx.chat.id,
            self_id: ctx.self_id,
            time: ctx.message.date,
            user_id: data.user_id,
            group_id: data.group_id,
            message: data.message,
            raw_message: data.raw_message,
        });

        Bot.em(`${data.post_type}.${data.message_type}`, data);
    }

    /**
     * 连接 Telegram Bot
     * 初始化 grammY 客户端，设置事件监听器
     * @param {string} token - Bot API Token
     * @returns {Promise<boolean>} - 连接是否成功
     */
    async connect(token) {
        const agent = config.proxy ? new HttpsProxyAgent(config.proxy) : undefined;
        const grammyBot = new GrammyBot(token, {
            client: {
                baseFetchConfig: {
                    baseUrl: config.reverseProxy || 'https://api.telegram.org', // Default base URL
                    agent, // Proxy agent if defined
                },
            },
        });
        grammyBot.api.config.use(autoRetry());
        // 格莱美初始化
        await grammyBot.init();
        grammyBot.info = await grammyBot.botInfo;

        if (!grammyBot.info?.id) {
            throw new Error('Failed to retrieve bot info');
        }
        // TG 机器人 ID
        const id = `tg_${grammyBot.info.id}`

        // 配置信息
        Bot[id] = grammyBot;
        if (!Bot.uin.includes(id)) Bot.uin.push(id)
        Bot[id].adapter = this;
        Bot[id].uid = id;
        Bot[id].uin = id;
        Bot[id].nickname = Bot[id].info.first_name || Bot[id].info.username || "TelegramBot"
        Bot[id].version = {
            id: this.id,
            name: this.name,
            app_name: "GrammY",
            app_version: `v${grammyVersion}`,
            version: this.version,
        }
        Bot[id].stat = {
            start_time: Date.now() / 1000,
            sent_msg_cnt: 0,
            recv_msg_cnt: 0,
            sent_image_cnt: 0
        }
        Bot[id].fl = new Map
        Bot[id].gl = new Map
        Bot[id].gml = new Map

        Bot[id].pickFriend = user_id => this.pickFriend(id, user_id)
        Bot[id].pickUser = Bot[id].pickFriend

        Bot[id].pickMember = (group_id, user_id) => this.pickMember(id, group_id, user_id)
        Bot[id].pickGroup = group_id => this.pickGroup(id, group_id)

        Bot[id].avatar = await Bot[id].pickFriend(id).getAvatarUrl()

        Bot[id].on("message", async (ctx) => {
            ctx.self_id = id;
            const mgid = ctx.message?.media_group_id;
            if (!mgid) return this.makeMessage(ctx);

            // 媒体组缓冲池，用于聚合相册消息（media_group_id）
            this.mediaGroupBuffer ??= new Map();
            // 生成缓冲键：bot_id:chat_id:media_group_id
            const key = `${id}:${ctx.chat.id}:${mgid}`;
            // 获取或创建缓冲对象
            const buf = this.mediaGroupBuffer.get(key) || { ctx0: ctx, items: [], timer: null };
            buf.items.push(ctx);
            // 清除之前的定时器，重新设置
            clearTimeout(buf.timer);
            // 600ms 后聚合发送，确保所有媒体消息都已收到
            buf.timer = setTimeout(() => {
                try {
                    const first = buf.items[0];
                    const base = {};
                    base.bot = Bot[id];
                    base.self_id = id;
                    base.post_type = "message";
                    base.user_id = `tg_${first.from.id}`;
                    base.sender = {
                        user_id: base.user_id,
                        nickname: first.from.first_name || first.from.username || "Unknown",
                        is_bot: !!first.from.is_bot,
                    };
                    base.is_bot = !!first.from.is_bot;
                    base.bot.fl.set(base.user_id, { ...first.from, ...base.sender });
                    base.message_type = first.chat.type === "supergroup" ? "group" : first.chat.type;
                    base.message = [];
                    base.message_ids = buf.items.map(m => m.message.message_id);
                    base.message_id = base.message_ids; // TRSS-Yunzai 习惯上在这里放数组或单个ID
                    base.id = first.chat.id;
                    base.entities = first.message.entities || first.message.caption_entities || [];
                    base.reply = (msg, clear = false, opts = {}) => {
                        const reply_id = Array.isArray(base.message_id) ? base.message_id[0] : base.message_id;
                        return this.sendMsg(base, msg, { ...opts, clear_history: clear, reply_to_message_id: reply_id })
                    }
                    base.raw_message = first.message.text || first.message.caption || "";
                    const replyTo = first.message.reply_to_message;
                    if (replyTo?.message_id) {
                        base.message.push({ type: "reply", id: replyTo.message_id, text: replyTo.text || replyTo.caption || "" });
                    }
                    if (base.raw_message) base.message.push({ type: "text", text: base.raw_message });

                    for (const mctx of buf.items) {
                        if (mctx.message.photo) {
                            const photo = mctx.message.photo[mctx.message.photo.length - 1];
                            base.message.push({ type: "image", file_id: photo.file_id, file_unique_id: photo.file_unique_id });
                        } else if (mctx.message.video) {
                            base.message.push({ type: "video", file_id: mctx.message.video.file_id });
                        } else if (mctx.message.document) {
                            base.message.push({ type: "file", file_id: mctx.message.document.file_id, file_name: mctx.message.document.file_name });
                        }
                    }

                    if (first.from.id === first.chat.id) {
                        Bot.makeLog("info", `好友消息：[${base.sender.nickname}(${base.user_id})] ${base.raw_message}`, id)
                        base.friend = base.bot.pickFriend(base.user_id);
                    } else {
                        base.group_id = `tg_${first.chat.id}`
                        base.group_name = `${first.chat.title || ''}${first.chat.username ? '-' + first.chat.username : ''}`
                        base.bot.gl.set(first.chat.id, {
                            ...first.chat,
                            group_id: base.group_id,
                            group_name: base.group_name,
                        })
                        Bot.makeLog("info", `群消息：[${base.group_name}(${base.group_id}), ${base.sender.nickname}(${base.user_id})] ${base.raw_message}`, id)
                        base.group = base.bot.pickGroup(base.group_id);
                    }

                    base.bot.stat.recv_msg_cnt++
                    if (global.redis) {
                        redis.incr(`Yz:count:receive:msg:bot:${id}:total`)
                    }

                    tgCacheMessage(id, first.chat.id, first.message.message_id, {
                        message_id: first.message.message_id,
                        chat_id: first.chat.id,
                        self_id: id,
                        time: first.message.date,
                        user_id: base.user_id,
                        group_id: base.group_id,
                        message: base.message,
                        raw_message: base.raw_message,
                    });

                    Bot.em(`${base.post_type}.${base.message_type}`, base);
                } finally {
                    this.mediaGroupBuffer.delete(key);
                }
            }, 600);
            this.mediaGroupBuffer.set(key, buf);
        })

        // 监听 Inline Keyboard 按钮点击回调
        Bot[id].on("callback_query:data", async (ctx) => {
            const callbackData = await tgDecodeCallbackData(id, ctx.callbackQuery.data);
            const from = ctx.callbackQuery.from;

            // 应答 TG 客户端（关闭按钮上的加载动画）
            await ctx.answerCallbackQuery();

            const data = {};
            data.bot = Bot[id];
            data.self_id = id;
            data.post_type = "message";
            data.user_id = `tg_${from.id}`;
            data.sender = {
                user_id: data.user_id,
                nickname: from.first_name || from.username || "Unknown",
                is_bot: !!from.is_bot,
            };
            data.is_bot = !!from.is_bot;
            data.bot.fl.set(data.user_id, { ...from, ...data.sender });

            // 消息制作
            data.message = [{ type: "text", text: callbackData }];
            data.msg = callbackData;
            data.raw_message = callbackData;

            // 附加回调原始信息，方便高级插件使用
            data.callback_query_id = ctx.callbackQuery.id;
            data.callback_message_id = ctx.msg?.message_id;
            data.id = ctx.chat?.id;
            data.reply = (msg, clear = false, opts = {}) => {
                return this.sendMsg(data, msg, { ...opts, clear_history: clear, reply_to_message_id: data.callback_message_id })
            }

            if (ctx.chat && ctx.chat.type !== "private") {
                data.message_type = "group";
                data.group_id = `tg_${ctx.chat.id}`;
                data.group_name = `${ctx.chat.title || ''}`;
                Bot.makeLog("info", `按钮回调：[${data.group_name}(${data.group_id}), ${data.sender.nickname}(${data.user_id})] ${callbackData}`, id);
                data.group = data.bot.pickGroup(data.group_id);
            } else {
                data.message_type = "private";
                Bot.makeLog("info", `按钮回调：[${data.sender.nickname}(${data.user_id})] ${callbackData}`, id);
                data.friend = data.bot.pickFriend(data.user_id);
            }

            // 统计更新
            data.bot.stat.recv_msg_cnt++
            if (global.redis) {
                redis.incr(`Yz:count:receive:msg:bot:${id}:total`)
            }

            Bot.em(`${data.post_type}.${data.message_type}`, data);
        })

        // 监听群成员变动 (notice.group_increase/group_decrease)
        Bot[id].on("chat_member", async (ctx) => {
            const { chat_member } = ctx.update;
            const { chat, from, new_chat_member, old_chat_member } = chat_member;
            const group_id = `tg_${chat.id}`;
            const user_id = `tg_${new_chat_member.user.id}`;

            const data = {
                bot: Bot[id],
                self_id: id,
                post_type: "notice",
                group_id,
                group_name: chat.title || "",
                user_id,
                operator_id: from ? `tg_${from.id}` : user_id,
            };

            const oldStatus = old_chat_member?.status;
            const newStatus = new_chat_member?.status;

            // 1) 入群 / 退群
            if (oldStatus === "left" && newStatus !== "left") {
                data.notice_type = "group_increase";
                Bot.makeLog("info", `成员入群：[${data.group_name}(${group_id})] ${user_id}`, id);
                data.group = data.bot.pickGroup(group_id);
                return Bot.em(`notice.${data.notice_type}`, data);
            }

            if (newStatus === "left" || newStatus === "kicked") {
                data.notice_type = "group_decrease";
                data.sub_type = newStatus === "kicked" ? "kick" : "leave";
                Bot.makeLog("info", `成员退群：[${data.group_name}(${group_id})] ${user_id}`, id);
                data.group = data.bot.pickGroup(group_id);
                return Bot.em(`notice.${data.notice_type}`, data);
            }

            // 2) 管理员变动
            const oldIsAdmin = oldStatus === "administrator" || oldStatus === "creator";
            const newIsAdmin = newStatus === "administrator" || newStatus === "creator";
            if (oldIsAdmin !== newIsAdmin) {
                data.notice_type = "group_admin";
                data.sub_type = newIsAdmin ? "set" : "unset";
                Bot.makeLog("info", `管理员变动：[${data.group_name}(${group_id})] ${user_id} ${data.sub_type}`, id);
                data.group = data.bot.pickGroup(group_id);
                return Bot.em(`notice.${data.notice_type}`, data);
            }

            // 3) 封禁/解封（kicked <-> 非 kicked）
            if (oldStatus === "kicked" && newStatus !== "kicked") {
                data.notice_type = "group_ban";
                data.sub_type = "lift";
                Bot.makeLog("info", `成员解封：[${data.group_name}(${group_id})] ${user_id}`, id);
                data.group = data.bot.pickGroup(group_id);
                return Bot.em(`notice.${data.notice_type}`, data);
            }

            if (newStatus === "kicked" && oldStatus !== "kicked") {
                data.notice_type = "group_ban";
                data.sub_type = "ban";
                Bot.makeLog("info", `成员封禁：[${data.group_name}(${group_id})] ${user_id}`, id);
                data.group = data.bot.pickGroup(group_id);
                return Bot.em(`notice.${data.notice_type}`, data);
            }

            // 4) 禁言/解除禁言（restricted 权限变动）
            const oldCanSend = old_chat_member?.can_send_messages;
            const newCanSend = new_chat_member?.can_send_messages;
            const oldIsRestricted = oldStatus === "restricted";
            const newIsRestricted = newStatus === "restricted";

            if ((!oldIsRestricted && newIsRestricted && newCanSend === false) || (oldCanSend !== false && newCanSend === false)) {
                data.notice_type = "group_mute";
                data.sub_type = "mute";
                data.duration = new_chat_member?.until_date ? Math.max(0, Number(new_chat_member.until_date) - Math.floor(Date.now() / 1000)) : undefined;
                Bot.makeLog("info", `成员禁言：[${data.group_name}(${group_id})] ${user_id}`, id);
                data.group = data.bot.pickGroup(group_id);
                return Bot.em(`notice.${data.notice_type}`, data);
            }

            if ((oldIsRestricted && !newIsRestricted) || (oldCanSend === false && newCanSend !== false)) {
                data.notice_type = "group_mute";
                data.sub_type = "unmute";
                Bot.makeLog("info", `成员解除禁言：[${data.group_name}(${group_id})] ${user_id}`, id);
                data.group = data.bot.pickGroup(group_id);
                return Bot.em(`notice.${data.notice_type}`, data);
            }
        })

        // 监听自身群权限变动 (notice.bot_status_change)
        Bot[id].on("my_chat_member", async (ctx) => {
            const { chat, new_chat_member, old_chat_member } = ctx.update.my_chat_member;
            const group_id = `tg_${chat.id}`;

            const data = {
                bot: Bot[id],
                self_id: id,
                post_type: "notice",
                group_id,
                group_name: chat.title || "",
            };

            if (new_chat_member.status === "member" && old_chat_member.status === "left") {
                data.notice_type = "bot_join_group";
                Bot.makeLog("info", `Bot 加入群组：[${data.group_name}(${group_id})]`, id);
            } else if (new_chat_member.status === "left" || new_chat_member.status === "kicked") {
                data.notice_type = "bot_leave_group";
                Bot.makeLog("info", `Bot 离开群组：[${data.group_name}(${group_id})]`, id);
            } else if (new_chat_member.status === "administrator" && old_chat_member.status !== "administrator") {
                data.notice_type = "bot_promote";
                Bot.makeLog("info", `Bot 被提升为管理员：[${data.group_name}(${group_id})]`, id);
            } else {
                return;
            }

            data.group = data.bot.pickGroup(group_id);
            Bot.em(`notice.${data.notice_type}`, data);
        })

        // 入群申请 (request.group.add)
        Bot[id].on("chat_join_request", async (ctx) => {
            const r = ctx.chatJoinRequest;
            const chat = r.chat;
            const from = r.from;

            const data = {
                bot: Bot[id],
                self_id: id,
                post_type: "request",
                request_type: "group",
                sub_type: "add",
                group_id: `tg_${chat.id}`,
                group_name: chat.title || "",
                user_id: `tg_${from.id}`,
                sender: {
                    user_id: `tg_${from.id}`,
                    nickname: from.first_name || from.username || "Unknown",
                },
                comment: r.bio || "",
                raw: r,
            };

            data.bot.fl.set(data.user_id, { ...from, ...data.sender });
            data.group = data.bot.pickGroup(data.group_id);

            Bot.makeLog("info", `入群申请：[${data.group_name}(${data.group_id}), ${data.sender.nickname}(${data.user_id})] ${data.comment || ""}`, id);
            Bot.em("request.group.add", data);
        })

        // 消息编辑 (notice.message_edit)
        Bot[id].on("edited_message", async (ctx) => {
            const m = ctx.editedMessage;
            if (!m) return;
            const chat = m.chat;
            const from = m.from;
            if (!chat || !from) return;

            const data = {
                bot: Bot[id],
                self_id: id,
                post_type: "notice",
                notice_type: "message_edit",
                message_id: m.message_id,
                id: chat.id,
                message_type: chat.type === "supergroup" ? "group" : chat.type,
                user_id: `tg_${from.id}`,
                sender: {
                    user_id: `tg_${from.id}`,
                    nickname: from.first_name || from.username || "Unknown",
                },
                raw_message: m.text || m.caption || "",
                entities: m.entities || m.caption_entities || [],
                raw: m,
            };

            data.bot.fl.set(data.user_id, { ...from, ...data.sender });

            // 群/私聊信息补齐
            if (chat.type !== "private") {
                data.group_id = `tg_${chat.id}`;
                data.group_name = `${chat.title || ''}${chat.username ? '-' + chat.username : ''}`;
                data.group = data.bot.pickGroup(data.group_id);
            } else {
                data.friend = data.bot.pickFriend(data.user_id);
            }

            Bot.makeLog("info", `消息编辑：[${chat.type !== "private" ? data.group_name + "(" + data.group_id + ")" : data.sender.nickname + "(" + data.user_id + ")"}] ${data.raw_message}`, id);
            Bot.em("notice.message_edit", data);
        })

        Bot.makeLog("mark", `${this.name}(${this.id}) - [${Bot[id].nickname}] - ${this.version} 已连接`, id)
        Bot.em(`connect.${id}`, { self_id: id })
        // 这里不要加 await 防止进程阻塞
        Bot[id].start();
        return true;
    }

    async load() {
        for (const token of config.token) {
            await this.connect(token);
        }
    }
}

Bot.adapter.push(adapter)

export class Telegram extends plugin {
    constructor() {
        super({
            name: "TelegramAdapter",
            dsc: "Telegram 适配器设置",
            event: "message",
            rule: [
                {
                    reg: "^#[Tt][Gg]账号$",
                    fnc: "List",
                    permission: config.permission,
                },
                {
                    reg: "^#[Tt][Gg]设置[0-9]+:.+$",
                    fnc: "Token",
                    permission: config.permission,
                },
                {
                    reg: "^#[Tt][Gg](代理|反代)",
                    fnc: "Proxy",
                    permission: config.permission,
                }
            ]
        })
    }

    List() {
        this.reply(`共${config.token.length}个账号：\n${config.token.join("\n")}`, true)
    }

    async Token() {
        const token = this.e.msg.replace(/^#[Tt][Gg]设置/, "").trim()
        if (config.token.includes(token)) {
            config.token = config.token.filter(item => item !== token)
            this.reply(`账号已删除，重启后生效，共${config.token.length}个账号`, true)
        } else {
            if (await adapter.connect(token)) {

                config.token.push(token)
                this.reply(`账号已连接，共${config.token.length}个账号`, true)
            } else {
                this.reply(`账号连接失败`, true)
                return false
            }
        }
        await configSave()
    }

    async Proxy() {
        const proxy = this.e.msg.replace(/^#[Tt][Gg](代理|反代)/, "").trim()
        if (this.e.msg.match("代理")) {
            config.proxy = proxy
            this.reply(`代理已${proxy ? "设置" : "删除"}，重启后生效`, true)
        } else {
            config.reverseProxy = proxy
            this.reply(`反代已${proxy ? "设置" : "删除"}，重启后生效`, true)
        }
        await configSave()
    }
}

logger.info(logger.green("- Telegram 适配器插件 加载完成"))