// index.js — Telegram Giveaway Bot (MyPickerBot) FULL VERSION

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

app.use(session({ secret: 'giveaway_secret', resave: false, saveUninitialized: true }));
app.use(bodyParser.urlencoded({ extended: true }));

const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

let giveaways = {};

function loadGiveaways() {
  try {
    giveaways = JSON.parse(fs.readFileSync('giveaways.json'));
  } catch {
    giveaways = {};
  }
}

function saveGiveaways() {
  fs.writeFileSync('giveaways.json', JSON.stringify(giveaways, null, 2));
}

function backupToDrive() {
  if (!fs.existsSync('token.json')) return;

  const token = JSON.parse(fs.readFileSync('token.json'));
  oauth2Client.setCredentials(token);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  drive.files.list({
    q: "name='giveaways.json' and trashed=false",
    fields: 'files(id, name)'
  }, (err, res) => {
    if (err) return console.error('Drive list error:', err);

    const fileMetadata = { name: 'giveaways.json' };
    const media = {
      mimeType: 'application/json',
      body: fs.createReadStream('giveaways.json')
    };

    if (res.data.files.length > 0) {
      const fileId = res.data.files[0].id;
      drive.files.update({ fileId, media }, err => {
        if (err) console.error('Drive update error:', err);
      });
    } else {
      drive.files.create({ resource: fileMetadata, media, fields: 'id' }, err => {
        if (err) console.error('Drive create error:', err);
      });
    }
  });
}

app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'] });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  fs.writeFileSync('token.json', JSON.stringify(tokens));
  res.send('Authorization successful. You can close this tab.');
});

app.get('/backup', (req, res) => {
  backupToDrive();
  res.send('Manual backup triggered.');
});

function createSheet(title) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync('token.json')) return reject('No Google token');
    const token = JSON.parse(fs.readFileSync('token.json'));
    oauth2Client.setCredentials(token);

    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    sheets.spreadsheets.create({
      resource: {
        properties: { title },
        sheets: [{
          properties: {
            title: 'Participants',
            gridProperties: { frozenRowCount: 1 }
          },
          data: [{
            startRow: 0,
            startColumn: 0,
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
    }, async (err, res) => {
      if (err) return reject(err);
      const sheetId = res.data.spreadsheetId;
      const drive = google.drive({ version: 'v3', auth: oauth2Client });
      await drive.permissions.create({
        fileId: sheetId,
        requestBody: { role: 'reader', type: 'anyone' }
      });
      resolve(`https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
    });
  });
}

function shuffle(array) {
  const buf = Buffer.alloc(array.length * 4);
  crypto.randomFillSync(buf);
  for (let i = array.length - 1; i > 0; i--) {
    const j = buf.readUInt32LE(i * 4) % (i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

bot.command('run', async ctx => {
  if (!ctx.channelPost) return;

  const channelId = ctx.channelPost.chat.id;
  const title = `Giveaway_${channelId}_${Date.now()}`;
  const sheetUrl = await createSheet(title);

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
    format: '🎉 Congratulations {username}!',
    winnerCount: 10
  };

  saveGiveaways();
});

bot.command('draw', async ctx => {
  const channelId = ctx.chat.id;
  const data = giveaways[channelId];
  if (!data || data.participants.length === 0) return ctx.reply('No participants found.');

  const shuffled = shuffle([...data.participants]);
  const winners = shuffled.slice(0, data.winnerCount);
  const formatted = winners.map(w => data.format.replace('{username}', `@${w.username}`)).join('\n');

  ctx.telegram.editMessageReplyMarkup(channelId, data.message_id, null, {
    inline_keyboard: [
      [{ text: '📄 View Sheet', url: data.sheetUrl }],
      [{ text: '⛔ Giveaway Ended', callback_data: 'ended', hide: true }]
    ]
  });

  ctx.reply(`🏆 WINNER ANNOUNCEMENT 🏆\n${formatted}`);
  delete giveaways[channelId];
  saveGiveaways();
});

bot.on('callback_query', async ctx => {
  const id = ctx.callbackQuery.data;
  if (!id.startsWith('join_')) return;
  const channelId = parseInt(id.split('_')[1]);
  const data = giveaways[channelId];
  if (!data) return ctx.answerCbQuery('Giveaway not found or expired.');

  const userId = ctx.from.id;
  if (data.participants.some(p => p.id === userId)) return ctx.answerCbQuery('Already joined!');

  const username = ctx.from.username || 'unknown';
  const now = new Date();
  const joinTime = `${String(now.getUTCDate()).padStart(2, '0')}/${String(now.getUTCMonth()+1).padStart(2, '0')}/${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;

  data.participants.push({ id: userId, username, joinTime });

  const token = JSON.parse(fs.readFileSync('token.json'));
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  const sheetId = data.sheetUrl.split('/d/')[1].split('/')[0];
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Participants!A:C',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[userId, username, joinTime]]
    }
  });

  await ctx.answerCbQuery('Successfully joined!');
  await ctx.telegram.editMessageText(channelId, data.message_id, null, `🎉 GIVEAWAY STARTED!\nClick to join using the button below!\n📊 Entries: ${data.participants.length}`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📄 View Sheet', url: data.sheetUrl }],
        [{ text: '✅ Participate', callback_data: `join_${channelId}` }]
      ]
    }
  });

  saveGiveaways();
});

loadGiveaways();
bot.launch();
app.listen(3000, () => console.log('🚀 Server running at http://localhost:3000'));

cron.schedule('0 0 * * *', () => {
  console.log('⏳ Daily Drive backup...');
  backupToDrive();
});
