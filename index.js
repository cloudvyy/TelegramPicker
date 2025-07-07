require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

app.use(session({ secret: 'keyboard cat', resave: false, saveUninitialized: true }));

const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

let oauthToken = null;

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  fs.writeFileSync('token.json', JSON.stringify(tokens));
  oauthToken = tokens;
  res.send('✅ Google Sheets API authorized!');
});

app.get('/', (req, res) => {
  res.send('TelegramPicker Bot is running.');
});

app.listen(3000, () => {
  console.log('🚀 Server running at http://localhost:3000');
  if (fs.existsSync('token.json')) {
    oauthToken = JSON.parse(fs.readFileSync('token.json'));
    oauth2Client.setCredentials(oauthToken);
    console.log('✅ Google Sheets API authorized!');
  }
});

const userConfigs = new Map();
const boundChannels = new Map();
const activeGiveaways = new Map();

function getUserConfig(userId) {
  if (!userConfigs.has(userId)) {
    userConfigs.set(userId, {
      customFormat: null,
      awaitingCustomFormat: false
    });
  }
  return userConfigs.get(userId);
}

function getConfig(userId) {
  const config = getUserConfig(userId);
  return {
    winnerCount: 10,
    customFormat: config.customFormat || null
  };
}

function showConfigMenu(ctx) {
  const config = getUserConfig(ctx.from.id);
  const text = `⚙️ Giveaway Configuration:\n🏆 Winner Count: 10\n📝 Custom Format: ${config.customFormat ? 'Custom' : 'Default'}\n\nChoose an option to configure:`;
  return ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback('Set Custom Format', 'set_custom_format')],
    [Markup.button.callback('Reset to Default', 'reset_config')]
  ]));
}

function getFormattedUTC() {
  const date = new Date();
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
}

async function createSheet(sheetTitle) {
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const sheet = await sheets.spreadsheets.create({
    resource: {
      properties: { title: sheetTitle },
      sheets: [{
        properties: { title: 'Sheet1' },
        data: [{
          rowData: [{
            values: [
              { userEnteredValue: { stringValue: 'User ID' } },
              { userEnteredValue: { stringValue: 'Username' } },
              { userEnteredValue: { stringValue: 'Join Time' } }
            ]
          }]
        }]
      }]
    }
  });

  await google.drive({ version: 'v3', auth: oauth2Client }).permissions.create({
    fileId: sheet.data.spreadsheetId,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return `https://docs.google.com/spreadsheets/d/${sheet.data.spreadsheetId}/edit`;
}

bot.start(async (ctx) => {
  await ctx.reply('🎉 Welcome! Use /run in your channel to start a giveaway.', {
    reply_markup: {
      keyboard: [[
        '⚙️ Configure Giveaway',
        '🔗 Bind Channel',
        '❌ Unbind Channel'
      ], ['📋 My Bound Channels', 'ℹ️ Help']],
      resize_keyboard: true
    }
  });
});

bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const config = getUserConfig(userId);

  if (config.awaitingCustomFormat) {
    config.customFormat = ctx.message.text;
    config.awaitingCustomFormat = false;
    await ctx.reply('✅ Custom format saved!');
    return showConfigMenu(ctx);
  }

  const text = ctx.message.text;

  if (text === '⚙️ Configure Giveaway') return showConfigMenu(ctx);

  if (text === '🔗 Bind Channel') return ctx.reply('📢 Please forward a message from your channel to me.');

  if (text === '❌ Unbind Channel') {
    const removed = [...boundChannels.entries()].filter(([cid, uid]) => uid === userId);
    removed.forEach(([cid]) => boundChannels.delete(cid));
    return ctx.reply(removed.length ? '✅ All channels unbound.' : '⚠️ No channels bound.');
  }

  if (text === '📋 My Bound Channels') {
    const list = [...boundChannels.entries()]
      .filter(([_, uid]) => uid === userId)
      .map(([id]) => `📢 ${id}`);
    return ctx.reply(list.length ? `📢 Your bound channels:\n${list.join('\n')}` : '⚠️ No channels bound.');
  }

  if (text === 'ℹ️ Help') {
    return ctx.reply(`🧩 Configuration Help:\n1. Use ⚙️ Configure Giveaway to set your preferences\n2. Configure custom winner display format\n📌 Forward a post from your channel here to bind it\n📢 Then use /run in the channel to start a giveaway`);
  }

  if (ctx.message.forward_from_chat) {
    boundChannels.set(ctx.message.forward_from_chat.id, userId);
    return ctx.reply('✅ Channel bound successfully! Now you can use /run in that channel.');
  }
});

bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id;
  const config = getUserConfig(userId);
  const action = ctx.callbackQuery.data;

  if (action === 'set_custom_format') {
    config.awaitingCustomFormat = true;
    await ctx.answerCbQuery();
    return ctx.editMessageText('📝 Enter your custom format.\nUse {count} and {winners}');
  }

  if (action === 'reset_config') {
    userConfigs.set(userId, { customFormat: null, awaitingCustomFormat: false });
    await ctx.answerCbQuery('✅ Configuration reset.');
    return showConfigMenu(ctx);
  }

  if (action.startsWith('join_')) {
    const giveawayId = action.split('_')[1];
    const g = [...activeGiveaways.values()].find(x => x.id === giveawayId);
    if (!g) return ctx.answerCbQuery('❌ Giveaway not found or expired.');

    const userId = ctx.from.id;
    if (g.ended) return ctx.answerCbQuery('❌ This giveaway is already over.');
    if (g.participants.find(p => p.id === userId)) return ctx.answerCbQuery('✅ You already joined!');

    const entry = {
      id: userId,
      username: ctx.from.username || '(no username)',
      time: getFormattedUTC()
    };

    g.participants.push(entry);

    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    await sheets.spreadsheets.values.append({
      spreadsheetId: g.sheetUrl.split('/')[5],
      range: 'Sheet1',
      valueInputOption: 'RAW',
      requestBody: { values: [[entry.id, entry.username, entry.time]] }
    });

    await ctx.answerCbQuery('🎉 You joined the giveaway!');

    try {
      await bot.telegram.editMessageText(
        g.channelId,
        g.messageId,
        null,
        `🎉 GIVEAWAY STARTED!\nClick to join using the button below!\n\n📊 Entries: ${g.participants.length}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 View Sheet', url: g.sheetUrl }],
              [{ text: '✨ Participate', callback_data: `join_${giveawayId}` }]
            ]
          }
        }
      );
    } catch (_) {}
  }
});

bot.on('channel_post', async (ctx) => {
  const messageText = ctx.channelPost.text?.trim().toLowerCase();
  const originalMsgId = ctx.channelPost.message_id;

  if (messageText === '/run') {
    const userId = boundChannels.get(ctx.chat.id);
    if (!userId) return;

    const giveawayId = uuidv4();
    const sheetUrl = await createSheet(`Giveaway_${Date.now()}`);
    const message = await ctx.reply('🎉 GIVEAWAY STARTED!\nClick to join using the button below!\n\n📊 Entries: 0', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 View Sheet', url: sheetUrl }],
          [{ text: '✨ Participate', callback_data: `join_${giveawayId}` }]
        ]
      }
    });

    activeGiveaways.set(ctx.chat.id, {
      id: giveawayId,
      channelId: ctx.chat.id,
      messageId: message.message_id,
      sheetUrl,
      userId,
      participants: [],
      ended: false
    });

    try { await bot.telegram.deleteMessage(ctx.chat.id, originalMsgId); } catch (_) {}
  }

  if (messageText === 'draw' || messageText === '/draw') {
    const g = activeGiveaways.get(ctx.chat.id);
    if (!g || g.participants.length === 0 || g.ended) return;

    const config = getConfig(g.userId);
    const winners = fisherYatesShuffle([...g.participants]).slice(0, config.winnerCount);
    const text = (config.customFormat || '🎉 Winners:\n{winners}')
      .replace('{count}', winners.length)
      .replace('{winners}', winners.map((u, i) => `${i + 1}. @${u.username}`).join('\n'));

    g.ended = true;
    await ctx.reply(`${text}`);

    try {
      await bot.telegram.editMessageReplyMarkup(g.channelId, g.messageId, null, {
        inline_keyboard: [
          [{ text: '📊 View Sheet', url: g.sheetUrl }],
          [{ text: '❌ Giveaway Ended', callback_data: 'ended', disabled: true }]
        ]
      });
    } catch (_) {}

    try { await bot.telegram.deleteMessage(ctx.chat.id, originalMsgId); } catch (_) {}
  }
});

function fisherYatesShuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(cryptoRandom() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function cryptoRandom() {
  return require('crypto').randomBytes(4).readUInt32LE() / 0xffffffff;
}

bot.launch().then(() => console.log('✅ Bot launched!'));
