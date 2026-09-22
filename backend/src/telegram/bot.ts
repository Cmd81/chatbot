import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { log } from '../logger.js';

const START_TEXT = [
  '👋 سلام!',
  '',
  'اینجا می‌تونی یک تماس تصویری کاملاً ناشناس با یک نفر تصادفی داشته باشی.',
  'اسم، شماره و آی‌دی تلگرامت به طرف مقابل نشون داده نمی‌شه و تصویر از طریق سرور رد می‌شه،',
  'پس آی‌پی شما و طرف مقابل هم به هم لو نمی‌ره.',
  '',
  'برای شروع دکمه‌ی زیر رو بزن 👇',
].join('\n');

const HELP_TEXT = [
  'ℹ️ راهنما',
  '',
  '• دکمه‌ی «📹 شروع تماس تصویری ناشناس» را بزنید تا مینی‌اپ باز شود.',
  '• اجازه‌ی دسترسی به دوربین و میکروفون را بدهید.',
  '• تا پیدا شدن نفر بعدی منتظر بمانید؛ به‌محض ورود کاربر دوم تماس شروع می‌شود.',
  '• هر وقت خواستید «پایان تماس» را بزنید و دوباره تماس جدید بگیرید.',
  '',
  `اگر ترجیح می‌دهید داخل مرورگر باز کنید: ${config.publicUrl}`,
].join('\n');

export function createBot(): Bot | null {
  if (config.telegram.mode === 'off' || !config.telegram.botToken) {
    log.info('telegram bot disabled');
    return null;
  }

  const bot = new Bot(config.telegram.botToken, {
    client: { apiRoot: config.telegram.apiRoot },
  });

  const keyboard = new InlineKeyboard().webApp('📹 شروع تماس تصویری ناشناس', config.publicUrl);

  bot.command('start', async (ctx) => {
    await ctx.reply(START_TEXT, { reply_markup: keyboard });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT, { reply_markup: keyboard });
  });

  bot.on('message', async (ctx) => {
    await ctx.reply('برای شروع، دکمه‌ی زیر را بزنید یا /start را بفرستید.', { reply_markup: keyboard });
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
    { command: 'start', description: 'شروع تماس تصویری ناشناس' },
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
