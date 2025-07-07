require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// ✅ Express session
app.use(session({ secret: 'keyboard cat', resave: false, saveUninitialized: true }));

// ✅ OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

let oauthToken = null;
const tokenPath = './token.json';

// ✅ /auth route
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
  });
  res.redirect(url);
});

// ✅ OAuth callback
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(tokenPath, JSON.stringify(tokens));
    oauthToken = tokens;
    res.send('✅ Google Sheets API authorized!');
  } catch (err) {
    console.error('OAuth error:', err);
    res.send('❌ Authorization failed.');
  }
});

// ✅ Load saved token
if (fs.existsSync(tokenPath)) {
  oauthToken = JSON.parse(fs.readFileSync(tokenPath));
  oauth2Client.setCredentials(oauthToken);
  console.log('✅ Google Sheets API authorized!');
}

const boundChannels = new Map();
const userConfigs = new Map();
const activeGiveaways = new Map();

function getUserConfig(userId) {
  if (!userConfigs.has(userId)) {
    userConfigs.set(userId, { customFormat: null, awaitingCustomFormat: false });
  }
  return userConfigs.get(userId);
}

function getConfig(userId) {
  const cfg = getUserConfig(userId);
  return {
    winnerCount: 10,
    customFormat: cfg.customFormat || null
  };
}

function showConfigMenu(ctx) {
  const config = getUserConfig(ctx.from.id);
  return ctx.reply(`⚙️ Giveaway Configuration:\n🏆 Winner Count: 10\n📝 Custom Format: ${config.customFormat ? 'Custom' : 'Default'}`, Markup.inlineKeyboard([
    [Markup.button.callback('Set Custom Format', 'set_custom_format')],
    [Markup.button.callback('Reset to Default', 'reset_config')]
  ]));
}

async function createSheet(title) {
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const sheet = await sheets.spreadsheets.create({
    resource: {
      properties: { title },
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
    requestBody: {
      role: 'reader',
      type: 'anyone'
    }
  });

  return `https://docs.google.com/spreadsheets/d/${sheet.data.spreadsheetId}/edit`;
}

// ✅ Telegraf Commands
bot.start(ctx => {
  ctx.reply('🎉 Welcome to Giveaway Bot!', Markup.keyboard([
    ['⚙️ Configure Giveaway', '🔗 Bind Channel'],
    ['📋 My Bound Channels', '❌ Unbind Channel']
  ]).resize());
});

bot.on('message', async ctx => {
  const userId = ctx.from.id;
  const cfg = getUserConfig(userId);

  if (cfg.awaitingCustomFormat) {
    cfg.customFormat = ctx.message.text;
    cfg.awaitingCustomFormat = false;
    return ctx.reply('✅ Custom format saved!');
  }

  if (ctx.message.text === '⚙️ Configure Giveaway') return showConfigMenu(ctx);
  if (ctx.message.text === '📋 My Bound Channels') {
    const list = [...boundChannels.entries()].filter(([, uid]) => uid === userId);
    return ctx.reply(list.length ? list.map(([id]) => `📢 ${id}`).join('\n') : '⚠️ No bound channels.');
  }
  if (ctx.message.text === '🔗 Bind Channel') return ctx.reply('📨 Forward a post from your channel.');
  if (ctx.message.text === '❌ Unbind Channel') {
    let removed = [...boundChannels.entries()].filter(([, uid]) => uid === userId);
    removed.forEach(([cid]) => boundChannels.delete(cid));
    return ctx.reply(removed.length ? '✅ Unbound.' : '⚠️ Nothing to unbind.');
  }

  if (ctx.message.forward_from_chat) {
    boundChannels.set(ctx.message.forward_from_chat.id, userId);
    return ctx.reply('✅ Channel bound!');
  }
});

// ✅ Callback Queries
bot.on('callback_query', async ctx => {
  const userId = ctx.from.id;
  const data = ctx.callbackQuery.data;
  const config = getUserConfig(userId);

  if (data === 'set_custom_format') {
    config.awaitingCustomFormat = true;
    return ctx.editMessageText('📝 Enter your custom format (use {count}, {winners})');
  }

  if (data === 'reset_config') {
    userConfigs.set(userId, { customFormat: null, awaitingCustomFormat: false });
    return showConfigMenu(ctx);
  }

  if (data.startsWith('join_')) {
    const id = data.split('_')[1];
    const g = [...activeGiveaways.values()].find(g => g.id === id);
    if (!g) return ctx.answerCbQuery('❌ Giveaway ended.');

    if (g.participants.some(p => p.id === userId)) return ctx.answerCbQuery('✅ Already joined.');

    const entry = {
      id: userId,
      username: ctx.from.username || '(no username)',
      time: new Date().toLocaleString()
    };
    g.participants.push(entry);

    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    await sheets.spreadsheets.values.append({
      spreadsheetId: g.sheetUrl.split('/')[5],
      range: 'Sheet1',
      valueInputOption: 'RAW',
      requestBody: { values: [[entry.id, entry.username, entry.time]] }
    });

    ctx.answerCbQuery('🎉 Joined!');
    try {
      await bot.telegram.editMessageText(
        g.channelId, g.messageId, null,
        `🎉 GIVEAWAY STARTED!\nClick below to join.\n\n📊 Entries: ${g.participants.length}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 View Sheet', url: g.sheetUrl }],
              [{ text: '✨ Participate', callback_data: `join_${g.id}` }]
            ]
          }
        }
      );
    } catch (_) {}
  }
});

// ✅ Giveaway Run & Draw
bot.on('channel_post', async ctx => {
  const text = ctx.channelPost.text?.trim().toLowerCase();
  const originalMsgId = ctx.channelPost.message_id;
  const chatId = ctx.chat.id;

  if (text === '/run') {
    const userId = boundChannels.get(chatId);
    if (!userId) return;

    const id = uuidv4();
    const sheetUrl = await createSheet(`Giveaway_${Date.now()}`);
    const msg = await ctx.reply(`🎉 GIVEAWAY STARTED!\nClick below to join.\n\n📊 Entries: 0`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 View Sheet', url: sheetUrl }],
          [{ text: '✨ Participate', callback_data: `join_${id}` }]
        ]
      }
    });

    activeGiveaways.set(chatId, {
      id,
      channelId: chatId,
      messageId: msg.message_id,
      sheetUrl,
      userId,
      participants: []
    });

    try { await bot.telegram.deleteMessage(chatId, originalMsgId); } catch (_) {}
  }

  if (text === '/draw') {
    const g = activeGiveaways.get(chatId);
    if (!g || g.participants.length === 0) return;

    const cfg = getConfig(g.userId);
    const winners = shuffle(g.participants).slice(0, cfg.winnerCount);
    const format = (cfg.customFormat || '🎉 Winners:\n{winners}')
      .replace('{count}', winners.length)
      .replace('{winners}', winners.map((u, i) => `${i + 1}. @${u.username}`).join('\n'));

    await ctx.reply(format);

    // Disable join button after draw
    try {
      await bot.telegram.editMessageText(chatId, g.messageId, null, `🎉 Giveaway Ended!\n\n📊 Final Entries: ${g.participants.length}`, {
        reply_markup: {
          inline_keyboard: [[{ text: '📊 View Sheet', url: g.sheetUrl }]]
        }
      });
    } catch (_) {}

    activeGiveaways.delete(chatId);
    try { await bot.telegram.deleteMessage(chatId, originalMsgId); } catch (_) {}
  }
});

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ✅ Start everything
app.listen(3000, () => {
  console.log('🚀 Server running at http://localhost:3000');
});

if (process.env.NODE_ENV === 'production') {
  bot.launch({ dropPendingUpdates: true }).then(() => console.log('🤖 Bot started (prod)'));
} else {
  bot.launch().then(() => console.log('🤖 Bot started (dev)'));
}
