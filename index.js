// index.js — MyPickerBot FULL FINAL PATCHED
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const { Telegraf } = require('telegraf');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const crypto = require('crypto');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

app.use(session({ secret: 'picker_secret', resave: false, saveUninitialized: true }));
app.use(bodyParser.urlencoded({ extended: true }));

let giveaways = {};
let userConfigs = {};

function loadGiveaways() {
  if (fs.existsSync('giveaways.json')) {
    giveaways = JSON.parse(fs.readFileSync('giveaways.json'));
  }
}

function saveGiveaways() {
  fs.writeFileSync('giveaways.json', JSON.stringify(giveaways, null, 2));
}

function getUserConfig(userId) {
  if (!userConfigs[userId]) {
    userConfigs[userId] = {
      winnerCount: 10,
      customFormat: '🎉 Congratulations {username}!',
      awaitingWinnerCount: false,
      awaitingCustomFormat: false
    };
  }
  return userConfigs[userId];
}

function backupToDrive() {
  if (!fs.existsSync('token.json')) return;
  oauth2Client.setCredentials(JSON.parse(fs.readFileSync('token.json')));
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const metadata = { name: 'giveaways.json' };
  const media = { mimeType: 'application/json', body: fs.createReadStream('giveaways.json') };

  drive.files.list({ q: "name='giveaways.json'", fields: 'files(id)' }, (err, res) => {
    if (err) return console.error('Drive list error:', err);
    if (res.data.files.length > 0) {
      drive.files.update({ fileId: res.data.files[0].id, media }, err => {
        if (err) console.error('Drive update error:', err);
      });
    } else {
      drive.files.create({ resource: metadata, media }, err => {
        if (err) console.error('Drive create error:', err);
      });
    }
  });
}

app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    fs.writeFileSync('token.json', JSON.stringify(tokens));
    res.send('✅ Authorization successful. You can close this tab.');
  } catch (err) {
    res.send('❌ Authorization failed.');
  }
});

function fisherYates(array) {
  const buf = Buffer.alloc(array.length * 4);
  crypto.randomFillSync(buf);
  for (let i = array.length - 1; i > 0; i--) {
    const j = buf.readUInt32LE(i * 4) % (i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function createSheet(title) {
  if (!fs.existsSync('token.json')) throw new Error('Token missing');
  oauth2Client.setCredentials(JSON.parse(fs.readFileSync('token.json')));
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  const res = await sheets.spreadsheets.create({
    resource: {
      properties: { title },
      sheets: [{
        properties: { title: 'Participants', gridProperties: { frozenRowCount: 1 } },
        data: [{
          startRow: 0,
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

  const sheetId = res.data.spreadsheetId;
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  await drive.permissions.create({
    fileId: sheetId,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
}

bot.on('channel_post', async ctx => {
  const text = ctx.channelPost.text;
  if (!text.startsWith('/run')) return;

  const channelId = ctx.channelPost.chat.id;
  const title = `Giveaway_${channelId}_${Date.now()}`;
  let sheetUrl;

  try {
    sheetUrl = await createSheet(title);
  } catch (e) {
    return ctx.reply('❌ Please authorize the bot at /auth first.');
  }

  const msg = await ctx.telegram.sendMessage(channelId, `🎉 GIVEAWAY STARTED!\nClick to join using the button below!\n📊 Entries: 0`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📄 View Sheet', url: sheetUrl }],
        [{ text: '✅ Participate', callback_data: `join_${channelId}` }]
      ]
    }
  });

  giveaways[channelId] = {
    message_id: msg.message_id,
    sheetUrl,
    participants: [],
    winnerCount: 10,
    format: '🎉 Congratulations {username}!'
  };

  saveGiveaways();
  ctx.deleteMessage(ctx.channelPost.message_id).catch(() => {});
});

bot.command('draw', async ctx => {
  const channelId = ctx.chat.id;
  const g = giveaways[channelId];
  if (!g || g.participants.length === 0) return ctx.reply('No participants found.');

  const winners = fisherYates([...g.participants]).slice(0, g.winnerCount);
  const text = winners.map(w => g.format.replace('{username}', `@${w.username}`)).join('\n');

  await ctx.telegram.editMessageReplyMarkup(channelId, g.message_id, null, {
    inline_keyboard: [
      [{ text: '📄 View Sheet', url: g.sheetUrl }],
      [{ text: '⛔ Giveaway Ended', callback_data: 'ended' }]
    ]
  });

  await ctx.reply(`🏆 WINNER ANNOUNCEMENT 🏆\n${text}`);
  delete giveaways[channelId];
  saveGiveaways();
  ctx.deleteMessage(ctx.message.message_id).catch(() => {});
});

bot.on('callback_query', async ctx => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('join_')) return;

  const channelId = parseInt(data.split('_')[1]);
  const g = giveaways[channelId];
  if (!g) return ctx.answerCbQuery('Giveaway not found or expired.');

  const userId = ctx.from.id;
  if (g.participants.some(p => p.id === userId)) return ctx.answerCbQuery('Already joined!');

  const username = ctx.from.username || 'unknown';
  const now = new Date();
  const joinTime = `${String(now.getUTCDate()).padStart(2, '0')}/${String(now.getUTCMonth()+1).padStart(2, '0')}/${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;

  g.participants.push({ id: userId, username, joinTime });

  oauth2Client.setCredentials(JSON.parse(fs.readFileSync('token.json')));
  const sheetId = g.sheetUrl.split('/d/')[1].split('/')[0];
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Participants!A:C',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[userId, username, joinTime]]
    }
  });

  await ctx.answerCbQuery('Successfully joined!');
  await ctx.telegram.editMessageText(channelId, g.message_id, null, `🎉 GIVEAWAY STARTED!\nClick to join using the button below!\n📊 Entries: ${g.participants.length}`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📄 View Sheet', url: g.sheetUrl }],
        [{ text: '✅ Participate', callback_data: `join_${channelId}` }]
      ]
    }
  });

  saveGiveaways();
});

bot.start(async ctx => {
  if (ctx.chat.type !== 'private') return;
  await ctx.reply('🎉 Welcome to MyPickerBot!\nUse /run in your channel.\nConfigure giveaway settings here.', {
    reply_markup: {
      keyboard: [['⚙️ Configure Giveaway'], ['📖 Help']],
      resize_keyboard: true
    }
  });
});

bot.hears('⚙️ Configure Giveaway', async ctx => {
  const config = getUserConfig(ctx.from.id);
  await ctx.reply(`⚙️ Giveaway Configuration:\nWinner Count: ${config.winnerCount}\nFormat: ${config.customFormat}`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Set Winner Count', callback_data: 'set_winner_count' }],
        [{ text: 'Set Custom Format', callback_data: 'set_custom_format' }],
        [{ text: 'Reset to Default', callback_data: 'reset_config' }]
      ]
    }
  });
});

bot.action('set_winner_count', async ctx => {
  const config = getUserConfig(ctx.from.id);
  config.awaitingWinnerCount = true;
  ctx.answerCbQuery();
  await ctx.reply('Enter new winner count (1-100):');
});

bot.action('set_custom_format', async ctx => {
  const config = getUserConfig(ctx.from.id);
  config.awaitingCustomFormat = true;
  ctx.answerCbQuery();
  await ctx.reply('Enter your custom winner format (use {username}):');
});

bot.action('reset_config', async ctx => {
  userConfigs[ctx.from.id] = null;
  ctx.answerCbQuery();
  await ctx.reply('✅ Configuration reset.');
});

bot.on('message', async ctx => {
  const config = getUserConfig(ctx.from.id);
  if (config.awaitingWinnerCount) {
    const count = parseInt(ctx.message.text);
    if (isNaN(count) || count < 1 || count > 100) {
      return ctx.reply('❌ Invalid number. Enter between 1-100.');
    }
    config.winnerCount = count;
    config.awaitingWinnerCount = false;
    return ctx.reply(`✅ Winner count set to ${count}`);
  }

  if (config.awaitingCustomFormat) {
    config.customFormat = ctx.message.text;
    config.awaitingCustomFormat = false;
    return ctx.reply('✅ Custom format updated.');
  }
});

// Boot
loadGiveaways();
bot.launch();
app.listen(3000, () => console.log('🚀 Server running at http://localhost:3000'));
cron.schedule('0 0 * * *', () => {
  console.log('📁 Daily backup to Drive...');
  backupToDrive();
});
