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

// Google OAuth2 Setup
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

let oauthToken = null;

app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]
  });
  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  fs.writeFileSync('token.json', JSON.stringify(tokens));
  oauthToken = tokens;
  res.send('✅ Google Sheets API authorized!');
});

app.listen(3000, () => {
  console.log('🚀 Server running at http://localhost:3000');
  if (fs.existsSync('token.json')) {
    oauthToken = JSON.parse(fs.readFileSync('token.json'));
    oauth2Client.setCredentials(oauthToken);
    console.log('✅ Google Sheets API authorized!');
  }
});

// Runtime State
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

async function createSheet(sheetTitle) {
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const sheet = await sheets.spreadsheets.create({
    resource: {
      properties: { title: sheetTitle },
      sheets: [{
        properties: {
          title: 'Sheet1',
          gridProperties: { frozenRowCount: 1 }
        },
        data: [{
          rowData: [{
            values: [
              { userEnteredValue: { stringValue: 'User ID' }, userEnteredFormat: { textFormat: { bold: true } } },
              { userEnteredValue: { stringValue: 'Username' }, userEnteredFormat: { textFormat: { bold: true } } },
              { userEnteredValue: { stringValue: 'Join Time' }, userEnteredFormat: { textFormat: { bold: true } } }
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

// Bot Start
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
    const removed = [...boundChannels.entries()].filter(([_, uid]) => uid === userId);
    removed.forEach(([cid]) => boundChannels.delete(cid));
    return ctx.reply(removed.length ? '✅ All channels unbound.' : '⚠️ No channels bound.');
  }
  if (text === '📋 My Bound Channels') {
    const list = [...boundChannels.entries()]
      .filter(([_, uid]) => uid === userId)
      .map(([cid]) => `📢 ${cid}`);
    return ctx.reply(list.length ? list.join('\n') : '⚠️ No channels bound.');
  }
  if (text === 'ℹ️ Help') {
    return ctx.reply(`📖 Help Guide:\n\n1. Use ⚙️ Configure Giveaway to set winner format\n2. Forward a post from your channel to bind it\n3. Use /run in the channel to start a giveaway\n4. Use /draw in the channel to pick winners`);
  }

  if (ctx.message.forward_from_chat) {
    boundChannels.set(ctx.message.forward_from_chat.id, userId);
    return ctx.reply('✅ Channel bound successfully!');
  }
});

// Callback Handler
bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id;
  const config = getUserConfig(userId);
  const action = ctx.callbackQuery.data;

  if (action === 'set_custom_format') {
    config.awaitingCustomFormat = true;
    await ctx.answerCbQuery();
    return ctx.editMessageText('📝 Enter your custom format. Use {count} and {winners}');
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

    if (g.winnersDrawn) return ctx.answerCbQuery('❌ Giveaway already ended.');

    const entry = {
      id: userId,
      username: ctx.from.username || '(no username)',
      time: new Date().toLocaleString()
    };

    if (g.participants.find(p => p.id === userId)) return ctx.answerCbQuery('✅ Already joined!');
    g.participants.push(entry);

    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    await sheets.spreadsheets.values.append({
      spreadsheetId: g.sheetUrl.split('/')[5],
      range: 'Sheet1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[entry.id, entry.username, entry.time]]
      }
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

// Handle /run and /draw
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
      winnersDrawn: false
    });

    try { await bot.telegram.deleteMessage(ctx.chat.id, originalMsgId); } catch (_) {}
  }

  if (messageText === 'draw' || messageText === '/draw') {
    const g = activeGiveaways.get(ctx.chat.id);
    if (!g || g.participants.length === 0) return;

    const config = getConfig(g.userId);
    const winners = shuffle(g.participants).slice(0, config.winnerCount);
    const text = (config.customFormat || '🎉 Winners:\n{winners}')
      .replace('{count}', winners.length)
      .replace('{winners}', winners.map((u, i) => `${i + 1}. @${u.username}`).join('\n'));

    await ctx.reply(text);

    g.winnersDrawn = true;

    // Update giveaway message to disable Participate
    try {
      await bot.telegram.editMessageText(
        g.channelId,
        g.messageId,
        null,
        `🎉 GIVEAWAY ENDED!\n\n🏆 Winners drawn.\n📊 Entries: ${g.participants.length}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 View Sheet', url: g.sheetUrl }],
              [{ text: '❌ Giveaway Ended', callback_data: 'closed' }]
            ]
          }
        }
      );
    } catch (_) {}

    try { await bot.telegram.deleteMessage(ctx.chat.id, originalMsgId); } catch (_) {}
  }
});

// Shuffle function
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

bot.launch().then(() => console.log('✅ Bot launched!'));
