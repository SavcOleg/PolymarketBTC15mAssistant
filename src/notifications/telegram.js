import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

dotenv.config();

class TelegramNotifier {
  constructor() {
    this.bot = null;
    this.chatId = null;
    this.enabled = false;
    this.initialize();
  }

  initialize() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.warn('[TelegramNotifier] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env, notifications disabled');
      return;
    }

    try {
      this.bot = new TelegramBot(token, { polling: false });
      this.chatId = chatId;
      this.enabled = true;
      console.log('[TelegramNotifier] Initialized successfully');
    } catch (error) {
      console.error('[TelegramNotifier] Failed to initialize:', error.message);
    }
  }

  async send(message, options = {}) {
    if (!this.enabled || !this.bot) {
      console.warn('[TelegramNotifier] Not enabled, message not sent:', message.slice(0, 100));
      return false;
    }

    try {
      const formattedMessage = this.formatMessage(message, options);
      await this.bot.sendMessage(this.chatId, formattedMessage, {
        parse_mode: options.parse_mode || 'HTML',
        disable_web_page_preview: true,
      });
      console.log('[TelegramNotifier] Message sent');
      return true;
    } catch (error) {
      console.error('[TelegramNotifier] Failed to send message:', error.message);
      return false;
    }
  }

  async sendTradeSignal(signal) {
    const {
      market,
      side,
      price,
      confidence,
      indicators,
      timestamp = new Date(),
      strategy = 'Unknown',
    } = signal;

    const emoji = side === 'UP' ? '🟢' : '🔴';
    const direction = side === 'UP' ? 'LONG' : 'SHORT';

    const message = `
${emoji} <b>${direction} Signal</b> ${emoji}
<b>Market:</b> ${market}
<b>Price:</b> ${price.toFixed(4)}
<b>Confidence:</b> ${(confidence * 100).toFixed(1)}%
<b>Strategy:</b> ${strategy}
<b>Time:</b> ${timestamp.toISOString().replace('T', ' ').substring(0, 19)}

<b>Indicators:</b>
${Object.entries(indicators || {}).map(([key, val]) => `  • ${key}: ${val}`).join('\n')}
    `.trim();

    return this.send(message);
  }

  async sendTradeFill(fill) {
    const {
      market,
      side,
      filledPrice,
      size,
      pnl,
      pnlPercent,
      timestamp = new Date(),
      orderId,
    } = fill;

    const emoji = pnl >= 0 ? '💰' : '💸';
    const pnlSign = pnl >= 0 ? '+' : '';

    const message = `
${emoji} <b>Trade Fill</b> ${emoji}
<b>Market:</b> ${market}
<b>Side:</b> ${side}
<b>Price:</b> ${filledPrice.toFixed(4)}
<b>Size:</b> ${size}
<b>PnL:</b> ${pnlSign}${pnl.toFixed(2)} USD (${pnlSign}${pnlPercent.toFixed(2)}%)
<b>Order ID:</b> ${orderId}
<b>Time:</b> ${timestamp.toISOString().replace('T', ' ').substring(0, 19)}
    `.trim();

    return this.send(message);
  }

  async sendAlert(level, title, description) {
    const levelEmoji = {
      info: 'ℹ️',
      warning: '⚠️',
      error: '🚨',
      critical: '🔥',
    };

    const emoji = levelEmoji[level] || '📢';

    const message = `
${emoji} <b>${title}</b> ${emoji}
${description}
    `.trim();

    return this.send(message);
  }

  formatMessage(message, options) {
    if (options.strip_newlines) {
      return message.replace(/\n/g, ' ');
    }
    return message;
  }
}

// Singleton instance
const telegramNotifier = new TelegramNotifier();
export default telegramNotifier;