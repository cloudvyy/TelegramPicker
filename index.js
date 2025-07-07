require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const cron = require('node-cron');
const { google } = require('googleapis');
const { Telegraf, Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

app.use(session({ secret: 'keyboard cat', resave: false, saveUninitialized: true }));

// Google Auth
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

let oauthToken = null;
const GIVEAWAYS_FILE = 'giveaways.json';
const DRIVE_FOLDER_NAME = 'TelePickerBackups';
let driveFolderId = null;

if (fs.existsSync('token.json')) {
  oauthToken = JSON.parse(fs.readFileSync('token.json'));
  oauth2Client.setCredentials(oauthToken);
  console.log('✅ Google Sheets API authorized!');
}

app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
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
});

const userConfigs = new Map();
const boundChannels = new Map();
const activeGiveaways = new Map();

// Load persistent giveaways
if (fs.existsSync(GIVEAWAYS_FILE)) {
  const saved = JSON.parse(fs.readFileSync(GIVEAWAYS_FILE));
  for (const [channelId, data] of Object.entries(saved)) {
    activeGiveaways.set(Number(channelId), data);
  }
}

// Save persistent giveaways
function saveGiveaways() {
  fs.writeFileSync(GIVEAWAYS_FILE, JSON.stringify(Object.fromEntries(activeGiveaways), null, 2));
}

// Backup to Google Drive
async function ensureDriveFolder() {
  if (driveFolderId) return driveFolderId;
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const existing = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and name='${DRIVE_FOLDER_NAME}'`,
    fields: 'files(id)'
  });
  if (existing.data.files.length) {
    driveFolderId = existing.data.files[0].id;
  } else {
    const folder = await drive.files.create({
      requestBody: {
        name: DRIVE_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder'
      }
    });
    driveFolderId = folder.data.id;
  }
  return driveFolderId;
}

async function uploadBackup() {
  if (!fs.existsSync(GIVEAWAYS_FILE)) return;
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const folderId = await ensureDriveFolder();
  const media = fs.createReadStream(GIVEAWAYS_FILE);
  await drive.files.create({
    requestBody: {
      name: `giveaways_${Date.now()}.json`,
      parents: [folderId]
    },
    media: {
      mimeType: 'application/json',
      body: media
    }
  });
}

// Cron: backup every day at 1 AM UTC
cron.schedule('0 1 * * *', uploadBackup);

// Helper
function getUserConfig(userId) {
  if (!userConfigs.has(userId)) {
    userConfigs.set(userId, { customFormat: null, awaitingCustomFormat: false });
  }
  return userConfigs.get(userId);
}

function getConfig(userId) {
  const config = getUserConfig(userId);
  return { winnerCount: 10, customFormat: config.customFormat || null };
}

function formatUTC() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').split('.')[0] + ' UTC';
}

function showConfigMenu(ctx) {
  const config = getUserConfig(ctx.from.id);
  return ctx.reply(
    `⚙️ Giveaway Configuration:\n🏆 Winner Count: 10\n📝 Custom Format: ${config.customFormat ? 'Custom' : 'Default'}\n\nChoose an option to configure:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Set Custom Format', 'set_custom_format')],
      [Markup.button.callback('Reset to Default', 'reset_config')]
    ])
  );
}

// Sheet helper
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
              { userEnteredValue: { stringValue: 'User ID' }, userEnteredFormat: { textFormat: { bold: true } } },
              { userEnteredValue: { stringValue: 'Username' }, userEnteredFormat: { textFormat: { bold: true } } },
              { userEnteredValue: { stringValue: 'Join Time (UTC)' }, userEnteredFormat: { textFormat: { bold: true } } }
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

// Start
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

// Private menu
bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const config = getUserConfig(userId);

  if (config.awaitingCustomFormat) {
    config.customFormat = ctx.message.text;
    config.awaitingCustomFormat = false;
    await ctx.reply('✅ Custom format saved!');
    return showConfigMenu(ctx);
  }

  if (ctx.message.text === '⚙️ Configure Giveaway') return showConfigMenu(ctx);
  if (ctx.message.text === '🔗 Bind Channel') return ctx.reply('📢 Please forward a message from your channel to bind.');
  if (ctx.message.text === '❌ Unbind Channel') {
    const removed = [...boundChannels.entries()].filter(([_, uid]) => uid === userId);
    removed.forEach(([cid]) => boundChannels.delete(cid));
    return ctx.reply(removed.length ? '✅ All channels unbound.' : '⚠️ No channels bound.');
  }

  if (ctx.message.text === '📋 My Bound Channels') {
    const list = [...boundChannels.entries()].filter(([_, uid]) => uid === userId);
    return ctx.reply(
      list.length ? list.map(([id]) => `📢 ${id}`).join('\n') : '⚠️ No channels bound.'
    );
  }

  if (ctx.message.text === 'ℹ️ Help') {
    return ctx.reply(`🧩 Help:\n1. ⚙️ Configure giveaway\n2. Forward post to bind\n3. Use /run in channel`);
  }

  if (ctx.message.forward_from_chat) {
    boundChannels.set(ctx.message.forward_from_chat.id, userId);
    return ctx.reply('✅ Channel bound!');
  }
});

// Config buttons
bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id;
  const config = getUserConfig(userId);
  const action = ctx.callbackQuery.data;

  if (action === 'set_custom_format') {
    config.awaitingCustomFormat = true;
    await ctx.answerCbQuery();
    return ctx.editMessageText('📝 Enter custom winner format using {count} and {winners}');
  }

  if (action === 'reset_config') {
    userConfigs.set(userId, { customFormat: null, awaitingCustomFormat: false });
    await ctx.answerCbQuery('✅ Config reset');
    return showConfigMenu(ctx);
  }

  if (action.startsWith('join_')) {
    const giveawayId = action.split('_')[1];
    const g = [...activeGiveaways.values()].find(x => x.id === giveawayId);
    if (!g) return ctx.answerCbQuery('❌ Giveaway not found or closed.');
    if (g.closed) return ctx.answerCbQuery('❌ Giveaway is over.');

    const userId = ctx.from.id;
    if (g.participants.find(p => p.id === userId)) return ctx.answerCbQuery('✅ Already joined');

    const entry = { id: userId, username: ctx.from.username || '(no username)', time: formatUTC() };
    g.participants.push(entry);

    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    await sheets.spreadsheets.values.append({
      spreadsheetId: g.sheetUrl.split('/')[5],
      range: 'Sheet1',
      valueInputOption: 'RAW',
      requestBody: { values: [[entry.id, entry.username, entry.time]] }
    });

    await ctx.answerCbQuery('🎉 You joined!');
    try {
      await bot.telegram.editMessageText(
        g.channelId,
        g.messageId,
        null,
        `🎉 GIVEAWAY STARTED!\n📊 Entries: ${g.participants.length}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 View Sheet', url: g.sheetUrl }],
              [{ text: '✨ Participate', callback_data: `join_${giveawayId}` }]
            ]
          }
        }
      );
    } catch {}
    saveGiveaways();
  }
});

// Channel commands
bot.on('channel_post', async (ctx) => {
  const messageText = ctx.channelPost.text?.trim().toLowerCase();
  const msgId = ctx.channelPost.message_id;
  const channelId = ctx.chat.id;

  if (messageText === '/run') {
    const userId = boundChannels.get(channelId);
    if (!userId) return;

    const giveawayId = uuidv4();
    const sheetUrl = await createSheet(`Giveaway_${Date.now()}`);
    const msg = await ctx.reply('🎉 GIVEAWAY STARTED!\n📊 Entries: 0', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 View Sheet', url: sheetUrl }],
          [{ text: '✨ Participate', callback_data: `join_${giveawayId}` }]
        ]
      }
    });

    activeGiveaways.set(channelId, {
      id: giveawayId,
      channelId,
      messageId: msg.message_id,
      sheetUrl,
      userId,
      participants: [],
      closed: false
    });

    saveGiveaways();
    uploadBackup();
    try { await bot.telegram.deleteMessage(channelId, msgId); } catch {}
  }

  if (messageText === 'draw' || messageText === '/draw') {
    const g = activeGiveaways.get(channelId);
    if (!g || g.participants.length === 0) return;

    g.closed = true;
    const config = getConfig(g.userId);
    const winners = fisherYatesShuffle(g.participants).slice(0, config.winnerCount);
    const text = (config.customFormat || '🎉 Winners:\n{winners}')
      .replace('{count}', winners.length)
      .replace('{winners}', winners.map((u, i) => `${i + 1}. @${u.username}`).join('\n'));

    await ctx.reply(`🏆 ${text}`);

    try {
      await bot.telegram.editMessageReplyMarkup(channelId, g.messageId, null, {
        inline_keyboard: [
          [{ text: '📊 View Sheet', url: g.sheetUrl }],
          [{ text: '❌ Giveaway Over', callback_data: 'closed' }]
        ]
      });
      await bot.telegram.deleteMessage(channelId, msgId);
    } catch {}
    saveGiveaways();
    uploadBackup();
  }
});

// Fair shuffle
function fisherYatesShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

bot.launch().then(() => console.log('🤖 Bot is running.'));
