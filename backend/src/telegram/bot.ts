import { Bot, GrammyError, HttpError, InlineKeyboard, Keyboard } from 'grammy';
import type { Context } from 'grammy';
import { config } from '../config.js';
import { log } from '../logger.js';
import { BotMatchmaker } from './chatMatch.js';

/** مچ‌میکر چت داخل ربات — کاملاً جدا از مچ‌میکر تماس تصویری. */
export const botChat = new BotMatchmaker();

// ── دکمه‌ها ─────────────────────────────────────────────────────────────────
const BTN_FIND = '🔎 پیدا کردن هم‌صحبت';
const BTN_CANCEL = '✖️ لغو جست‌وجو';
const BTN_NEXT = '⏭ نفر بعدی';
const BTN_STOP = '⛔️ پایان چت';
const BUTTONS = new Set([BTN_FIND, BTN_CANCEL, BTN_NEXT, BTN_STOP]);

const kbIdle = new Keyboard().text(BTN_FIND).resized().persistent();
const kbWaiting = new Keyboard().text(BTN_CANCEL).resized().persistent();
const kbChatting = new Keyboard().text(BTN_NEXT).text(BTN_STOP).resized().persistent();

const START_TEXT = [
  '👋 سلام!',
  '',
  'اینجا دو کار می‌توانی بکنی:',
  '',
  '💬 <b>چت ناشناس</b> — همین‌جا داخل تلگرام با یک نفر تصادفی چت کن.',
  'متن، عکس، ویدیو، ویس، استیکر، فایل… هر چیزی که بفرستی رد می‌شود،',
  'ولی <b>هیچ ردی از اینکه تو فرستاده‌ای نمی‌ماند</b>.',
  '',
  '📹 <b>تماس تصویری ناشناس</b> — با دکمه‌ی پایین باز می‌شود.',
  '',
  'برای شروع چت، دکمه‌ی «🔎 پیدا کردن هم‌صحبت» را بزن.',
].join('\n');

const HELP_TEXT = [
  'ℹ️ <b>راهنما</b>',
  '',
  '/chat — پیدا کردن هم‌صحبت',
  '/next — رفتن سراغ نفر بعدی',
  '/stop — پایان چت',
  '',
  '• نام، شماره و آی‌دی تلگرام تو به طرف مقابل نشان داده نمی‌شود.',
  '• پیام‌ها روی سرور ما ذخیره نمی‌شوند.',
  '• می‌توانی روی پیام طرف مقابل reply بزنی؛ درست منتقل می‌شود.',
].join('\n');

function videoKeyboard(): InlineKeyboard {
  return new InlineKeyboard().webApp('📹 شروع تماس تصویری ناشناس', config.publicUrl);
}

// ── کمک‌کارها ───────────────────────────────────────────────────────────────

/** ارسال امن؛ اگر کاربر ربات را بلاک کرده باشد نباید کل هندلر بشکند. */
async function tell(ctx: Context, chatId: number, text: string, keyboard?: Keyboard): Promise<boolean> {
  try {
    await ctx.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    return true;
  } catch (err) {
    log.warn('telegram send failed', { chatId, err: String(err) });
    return false;
  }
}

/** کیبورد متناسب با وضعیت فعلی کاربر. */
function keyboardFor(chatId: number): Keyboard {
  if (botChat.isChatting(chatId)) return kbChatting;
  if (botChat.isWaiting(chatId)) return kbWaiting;
  return kbIdle;
}

/**
 * جست‌وجوی هم‌صحبت.
 *
 * اگر نفرِ بالای صف دیگر در دسترس نباشد (ربات را بلاک کرده)، سراغ نفر بعدی
 * می‌رویم. این کار با حلقه انجام می‌شود نه بازگشت، تا صفِ پر از کاربرِ
 * از‌دست‌رفته پشته را پر نکند.
 */
async function startSearch(ctx: Context, chatId: number): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await trySearchOnce(ctx, chatId)) return;
  }
  await ctx.reply('فعلاً کسی در دسترس نیست. کمی بعد دوباره امتحان کنید.', { reply_markup: kbIdle });
}

/** خروجی false یعنی طرف مقابل در دسترس نبود و باید دوباره تلاش شود. */
async function trySearchOnce(ctx: Context, chatId: number): Promise<boolean> {
  const result = botChat.join(chatId);

  switch (result.status) {
    case 'already_chatting':
      await ctx.reply('شما هم‌اکنون در یک چت هستید. برای رفتن سراغ نفر بعدی «⏭ نفر بعدی» را بزنید.', {
        reply_markup: kbChatting,
      });
      return true;

    case 'already_queued':
      await ctx.reply('در صف هستید؛ کمی صبر کنید…', { reply_markup: kbWaiting });
      return true;

    case 'queued':
      await ctx.reply('🔎 در حال گشتن دنبال یک نفر…\nبه‌محض پیدا شدن، خبرت می‌کنم.', {
        reply_markup: kbWaiting,
      });
      return true;

    case 'matched': {
      const text = [
        '✅ یک نفر پیدا شد!',
        '',
        'هر چه بفرستی برایش می‌رود — متن، عکس، ویدیو، ویس، استیکر، فایل…',
        'کسی نمی‌فهمد تو کی هستی.',
        '',
        '⚠️ مراقب باش چیزی که هویتت را لو می‌دهد (شماره، مخاطب، موقعیت مکانی) نفرستی.',
      ].join('\n');

      const delivered = await tell(ctx, result.partner, text, kbChatting);
      if (!delivered) {
        // طرف مقابل در دسترس نیست؛ جلسه را باز می‌کنیم و سراغ نفر بعدی می‌رویم
        botChat.end(chatId);
        return false;
      }
      await ctx.reply(text, { reply_markup: kbChatting });
      log.info('bot chat matched', { ...botChat.stats() });
      return true;
    }
  }
}

async function stopChat(ctx: Context, chatId: number, quiet = false): Promise<boolean> {
  const partner = botChat.end(chatId);
  if (partner === null) {
    if (!quiet) {
      await ctx.reply('در حال حاضر در چتی نیستید.', { reply_markup: kbIdle });
    }
    return false;
  }
  await tell(ctx, partner, '👋 طرف مقابل چت را ترک کرد.\nبرای پیدا کردن یک نفر دیگر دکمه‌ی زیر را بزنید.', kbIdle);
  log.info('bot chat ended', botChat.stats());
  return true;
}

// ── ساخت ربات ───────────────────────────────────────────────────────────────

export function createBot(): Bot | null {
  if (config.telegram.mode === 'off' || !config.telegram.botToken) {
    log.info('telegram bot disabled');
    return null;
  }

  const bot = new Bot(config.telegram.botToken, {
    client: { apiRoot: config.telegram.apiRoot },
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(START_TEXT, { parse_mode: 'HTML', reply_markup: videoKeyboard() });
    if (ctx.chat.type !== 'private') return;
    // اگر وسط چت /start بزند، نباید کیبوردش عوض شود
    const chatting = botChat.isChatting(ctx.chat.id);
    await ctx.reply(chatting ? 'چت فعلی‌ات هنوز برقرار است 👇' : 'برای چت متنی، دکمه‌ی زیر 👇', {
      reply_markup: keyboardFor(ctx.chat.id),
    });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
  });

  bot.command('video', async (ctx) => {
    await ctx.reply('📹 تماس تصویری ناشناس:', { reply_markup: videoKeyboard() });
  });

  bot.command('chat', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await startSearch(ctx, ctx.chat.id);
  });

  bot.command('next', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await stopChat(ctx, ctx.chat.id, true);
    await startSearch(ctx, ctx.chat.id);
  });

  bot.command('stop', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const chatId = ctx.chat.id;
    if (botChat.cancel(chatId)) {
      await ctx.reply('جست‌وجو لغو شد.', { reply_markup: kbIdle });
      return;
    }
    if (await stopChat(ctx, chatId)) {
      await ctx.reply('چت تمام شد.', { reply_markup: kbIdle });
    }
  });

  // ── بازپخش پیام‌ها ────────────────────────────────────────────────────────
  bot.on('message', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    // دکمه‌های کیبورد، متن معمولی می‌فرستند؛ نباید بازپخش شوند.
    if (text && BUTTONS.has(text)) {
      if (text === BTN_FIND) {
        await startSearch(ctx, chatId);
      } else if (text === BTN_CANCEL) {
        const wasWaiting = botChat.cancel(chatId);
        await ctx.reply(wasWaiting ? 'جست‌وجو لغو شد.' : 'در صف نبودید.', { reply_markup: kbIdle });
      } else if (text === BTN_NEXT) {
        await stopChat(ctx, chatId, true);
        await startSearch(ctx, chatId);
      } else if (text === BTN_STOP) {
        if (await stopChat(ctx, chatId)) {
          await ctx.reply('چت تمام شد.', { reply_markup: kbIdle });
        }
      }
      return;
    }

    const session = botChat.sessionOf(chatId);
    if (!session) {
      if (botChat.isWaiting(chatId)) {
        await ctx.reply('هنوز کسی پیدا نشده؛ به‌محض پیدا شدن خبرت می‌کنم.', { reply_markup: kbWaiting });
      } else {
        await ctx.reply('برای شروع، «🔎 پیدا کردن هم‌صحبت» را بزنید.', { reply_markup: kbIdle });
      }
      return;
    }

    const partner = session.a === chatId ? session.b : session.a;

    // اگر کاربر روی پیامی reply زده، معادلش را در چت طرف مقابل پیدا می‌کنیم.
    const repliedTo = ctx.message.reply_to_message?.message_id;
    const mappedReply = repliedTo === undefined ? undefined : session.relay.lookup(chatId, repliedTo);

    const copyOnce = async (): Promise<{ message_id: number }> =>
      ctx.api.copyMessage(partner, chatId, ctx.message.message_id, {
        ...(mappedReply === undefined ? {} : { reply_parameters: { message_id: mappedReply } }),
      });

    try {
      /**
       * copyMessage دقیقاً ابزار درست است: محتوا را بدون هیچ اشاره‌ای به
       * فرستنده‌ی اصلی کپی می‌کند (برخلاف forwardMessage که «فوروارد شده از…»
       * نشان می‌دهد) و همه‌ی انواع پیام را پشتیبانی می‌کند — متن، عکس، ویدیو،
       * ویس، ویدیو-نوت، فایل، استیکر، گیف، مخاطب، موقعیت، نظرسنجی و تاس.
       *
       * ضمناً ما هرگز فایل را دانلود نمی‌کنیم؛ فقط شناسه‌ی پیام را به تلگرام
       * می‌دهیم. یعنی هیچ محتوایی حتی از سرور ما عبور هم نمی‌کند.
       */
      let copied: { message_id: number };
      try {
        copied = await copyOnce();
      } catch (err) {
        // تلگرام روی ارسال پیاپی محدودیت نرخ دارد؛ یک بار صبر و تلاش دوباره.
        const retryAfter = err instanceof GrammyError ? err.parameters?.retry_after : undefined;
        if (retryAfter === undefined) throw err;
        await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 10) * 1000));
        copied = await copyOnce();
      }
      session.relay.remember(chatId, ctx.message.message_id, partner, copied.message_id);
    } catch (err) {
      const description = err instanceof GrammyError ? err.description : String(err);
      log.warn('relay failed', { err: description });

      // پیام‌های سرویسی (سنجاق کردن، عضو جدید و…) قابل کپی نیستند — بی‌صدا رد شوند.
      if (description.includes("can't be copied") || description.includes('MESSAGE_ID_INVALID')) return;

      // طرف مقابل دیگر در دسترس نیست
      await stopChat(ctx, chatId, true);
      await ctx.reply('طرف مقابل دیگر در دسترس نیست. چت تمام شد.', { reply_markup: kbIdle });
    }
  });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) log.error('telegram api error', { description: e.description });
    else if (e instanceof HttpError) log.error('telegram network error', { err: String(e) });
    else log.error('telegram handler error', { err: String(e) });
  });

  return bot;
}

/** تنظیم دکمه‌ی منوی ربات روی نشانی مینی‌اپ + لیست دستورات. */
export async function configureBotChrome(bot: Bot): Promise<void> {
  if (!config.telegram.setMenuButton) return;
  await bot.api.setChatMenuButton({
    menu_button: {
      type: 'web_app',
      text: '📹 تماس ناشناس',
      web_app: { url: config.publicUrl },
    },
  });
  await bot.api.setMyCommands([
    { command: 'chat', description: 'پیدا کردن هم‌صحبت برای چت ناشناس' },
    { command: 'next', description: 'رفتن سراغ نفر بعدی' },
    { command: 'stop', description: 'پایان چت' },
    { command: 'video', description: 'تماس تصویری ناشناس' },
    { command: 'help', description: 'راهنما' },
  ]);
  log.info('telegram menu button configured', { url: config.publicUrl });
}

/**
 * راه‌اندازی ربات. خطاهای شبکه‌ی تلگرام نباید سرویس وب را از کار بیندازند،
 * چون مسیر دوم (سایت معمولی) مستقل از تلگرام کار می‌کند.
 */
export async function startBot(bot: Bot): Promise<void> {
  try {
    if (config.telegram.mode === 'polling') {
      // اگر قبلاً webhook تنظیم شده باشد، long polling خطای 409 می‌دهد.
      await bot.api.deleteWebhook({ drop_pending_updates: true });
      await configureBotChrome(bot);
      void bot
        .start({
          drop_pending_updates: true,
          onStart: (me) => log.info('telegram bot started (polling)', { username: me.username }),
        })
        .catch((err) => log.error('telegram polling stopped', { err: String(err) }));
      return;
    }

    // حالت webhook: مسیر در index.ts ثبت می‌شود.
    await bot.init();
    await configureBotChrome(bot);
    const url = `${config.publicUrl}/telegram/webhook/${config.telegram.webhookSecret}`;
    await bot.api.setWebhook(url, {
      secret_token: config.telegram.webhookSecret,
      drop_pending_updates: true,
      allowed_updates: ['message'],
    });
    log.info('telegram bot started (webhook)', { username: bot.botInfo.username });
  } catch (err) {
    log.error('telegram bot failed to start; web app keeps working', { err: String(err) });
  }
}
