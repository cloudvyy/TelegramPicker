
// Telegram Giveaway Bot - Fully Patched Version
require('dotenv').config();
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const { google } = require('googleapis');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const crypto = require('crypto');
const path = require('path');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const giveawaysFile = './giveaways.json';
const tokenPath = 'token.json';

app.use(session({ secret: 'secret', resave: false, saveUninitialized: true }));
app.use(express.urlencoded({ extended: true }));

let giveaways = {};
if (fs.existsSync(giveawaysFile)) {
  giveaways = JSON.parse(fs.readFileSync(giveawaysFile, 'utf8'));
}

function saveGiveaways() {
  fs.writeFileSync(giveawaysFile, JSON.stringify(giveaways, null, 2));
}

// Setup OAuth2 Client
const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

if (fs.existsSync(tokenPath)) {
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenPath)));
}

async function createSheet(title) {
  const sheets = google.sheets({ version: 'v4', auth: oAuth2Client });
  const resource = { properties: { title } };
  const spreadsheet = await sheets.spreadsheets.create({ resource });
  const spreadsheetId = spreadsheet.data.spreadsheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [
        { updateSheetProperties: { properties: { sheetId: 0, title: "Participants", gridProperties: { frozenRowCount: 1 } }, fields: "title,gridProperties.frozenRowCount" } }
      ]
    }
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Participants!A1:C1",
    valueInputOption: "RAW",
    resource: {
      values: [["User ID", "Username", "Join Time"]]
    }
  });

  await sheets.permissions.create({
    fileId: spreadsheetId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    }
  });

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, spreadsheetId;
}

function formatUTCDate() {
  const now = new Date();
  const day = String(now.getUTCDate()).padStart(2, '0');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const year = now.getUTCFullYear();
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes} UTC`;
}

bot.on('channel_post', async (ctx) => {
  const msg = ctx.channelPost;
  if (!msg.text || !msg.text.startsWith('/run')) return;

  const channelId = msg.chat.id.toString();
  const giveawayId = uuidv4();
  const title = `Giveaway_${giveawayId.slice(0, 8)}`;
  const [sheetUrl, sheetId] = await createSheet(title);

  const text = `🎉 GIVEAWAY STARTED!
Click to join using the button below!
📊 Entries: 0`;

  const markup = Markup.inlineKeyboard([
    Markup.button.url('📊 View Sheet', sheetUrl),
    Markup.button.callback('✨ Participate', `join_${giveawayId}`)
  ]);

  const post = await ctx.telegram.sendMessage(channelId, text, { reply_markup: markup.reply_markup });
  ctx.telegram.deleteMessage(channelId, msg.message_id);

  giveaways[giveawayId] = {
    id: giveawayId,
    channelId,
    messageId: post.message_id,
    sheetId,
    participants: [],
    url: sheetUrl,
    format: '🎉 Winner: {username}',
    count: 10,
    active: true
  };
  saveGiveaways();
});

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('join_')) return;

  const giveawayId = data.split('_')[1];
  const entry = giveaways[giveawayId];
  if (!entry || !entry.active) return ctx.answerCbQuery('Giveaway not found or expired.');

  const userId = ctx.from.id;
  if (entry.participants.find(p => p.id === userId)) return ctx.answerCbQuery('Already joined.');

  const username = ctx.from.username || `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim();
  const joinTime = formatUTCDate();

  entry.participants.push({ id: userId, username, time: joinTime });
  saveGiveaways();

  const sheets = google.sheets({ version: 'v4', auth: oAuth2Client });
  await sheets.spreadsheets.values.append({
    spreadsheetId: entry.sheetId,
    range: 'Participants!A2:C',
    valueInputOption: 'RAW',
    resource: { values: [[userId, username, joinTime]] }
  });

  const newText = `🎉 GIVEAWAY STARTED!
Click to join using the button below!
📊 Entries: ${entry.participants.length}`;
  const markup = Markup.inlineKeyboard([
    Markup.button.url('📊 View Sheet', entry.url),
    Markup.button.callback('✨ Participate', `join_${giveawayId}`)
  ]);
  await ctx.telegram.editMessageText(entry.channelId, entry.messageId, null, newText, { reply_markup: markup.reply_markup });

  ctx.answerCbQuery('You have joined!');
});

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

bot.command('draw', async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const latest = Object.values(giveaways).reverse().find(g => g.channelId === chatId && g.active);
  if (!latest) return ctx.reply('No active giveaway.');

  latest.active = false;
  saveGiveaways();

  const winners = shuffle(latest.participants).slice(0, latest.count);
  const formatted = winners.map((w, i) => latest.format.replace('{username}', `@${w.username}`)).join('
');
  await ctx.telegram.sendMessage(chatId, `🎉 Giveaway Winners:
${formatted}`);

  const markup = Markup.inlineKeyboard([Markup.button.url('📊 View Sheet', latest.url)]);
  await ctx.telegram.editMessageReplyMarkup(chatId, latest.messageId, null, { inline_keyboard: [ [Markup.button.callback('❌ Giveaway Ended', '')] ] });
});

// OAuth & Auth Routes
app.get('/auth', (req, res) => {
  const url = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'] });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(tokenPath, JSON.stringify(tokens));
  res.send('Authorization successful! You can close this page.');
});

async function uploadToDrive() {
  const drive = google.drive({ version: 'v3', auth: oAuth2Client });
  const fileMetadata = { name: 'giveaways_backup.json' };
  const media = { mimeType: 'application/json', body: fs.createReadStream(giveawaysFile) };
  const file = await drive.files.create({ resource: fileMetadata, media, fields: 'id' });
  return file.data;
}

app.get('/backup', async (req, res) => {
  try {
    const backup = await uploadToDrive();
    res.send(`Backup complete. File ID: ${backup.id}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Backup failed.');
  }
});

bot.launch();
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
