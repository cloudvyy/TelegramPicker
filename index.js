require('dotenv').config();
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const { Telegraf, Markup } = require('telegraf');
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
let config = {};
const CONFIG_FILE = 'giveaway_config.json';
const G_FILE = 'giveaways.json';

function loadGiveaways() {
  try {
    giveaways = JSON.parse(fs.readFileSync(G_FILE));
  } catch {
    giveaways = {};
  }

  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE));
  } catch {
    config = {};
  }
}

function saveGiveaways() {
  fs.writeFileSync(G_FILE, JSON.stringify(giveaways, null, 2));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function fisherYates(arr) {
  const buf = Buffer.alloc(arr.length * 4);
  crypto.randomFillSync(buf);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = buf.readUInt32LE(i * 4) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function backupToDrive() {
  if (!fs.existsSync('token.json')) return;
  oauth2Client.setCredentials(JSON.parse(fs.readFileSync('token.json')));
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  drive.files.list({ q: "name='giveaways.json'", fields: 'files(id)' }, (err, res) => {
    if (err) return;
    const media = { mimeType: 'application/json', body: fs.createReadStream(G_FILE) };
    if (res.data.files.length > 0) {
      drive.files.update({ fileId: res.data.files[0].id, media }, () => {});
    } else {
      drive.files.create({ resource: { name: 'giveaways.json' }, media }, () => {});
    }
  });
}

function createSheet(title) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync('token.json')) return reject('Missing token.json');
    oauth2Client.setCredentials(JSON.parse(fs.readFileSync('token.json')));
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    sheets.spreadsheets.create({
      resource: {
        properties: { title },
        sheets: [{
          properties: { title: 'Participants', gridProperties: { frozenRowCount: 1 } },
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
    }, async (err, res) => {
      if (err) return reject(err);
      const sheetId = res.data.spreadsheetId;
      const drive = google.drive({ version: 'v3', auth: oauth2Client });
      await drive.permissions.create({ fileId: sheetId, requestBody: { role: 'reader', type: 'anyone' } });
      resolve(`https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
    });
  });
}

bot.command('run', async ctx => {
  const channelPost = ctx.channelPost;
  if (!channelPost) return;
  const chatId = channelPost.chat.id;
  const title = `Giveaway_${chatId}_${Date.now()}`;
  const sheetUrl = await createSheet(title);
  const message = await ctx.telegram.sendMessage(chatId, `🎉 GIVEAWAY STARTED!\nClick to join using the button below!\n📊 Entries: 0`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📄 View Sheet', url: sheetUrl }],
        [{ text: '✅ Participate', callback_data: `join_${chatId}` }]
      ]
    }
  });

  giveaways[chatId] = {
    message_id: message.message_id,
    sheetUrl,
    participants: [],
    winnerCount: config[chatId]?.count || 10,
    format: config[chatId]?.format || '🎉 Congratulations {username}!'
  };

  saveGiveaways();
  ctx.deleteMessage(channelPost.message_id).catch(() => {});
});

bot.command('draw', async ctx => {
  const chatId = ctx.chat.id;
  const g = giveaways[chatId];
  if (!g || g.participants.length === 0) return ctx.reply('No participants found.');
  const shuffled = fisherYates([...g.participants]);
  const winners = shuffled.slice(0, g.winnerCount);
  const result = winners.map(w => g.format.replace('{username}', `@${w.username}`)).join('\n');

  await ctx.telegram.editMessageReplyMarkup(chatId, g.message_id, null, {
    inline_keyboard: [
      [{ text: '📄 View Sheet', url: g.sheetUrl }],
      [{ text: '⛔ Giveaway Ended', callback_data: 'ended' }]
    ]
  });

  ctx.reply(`🏆 WINNER ANNOUNCEMENT 🏆\n${result}`);
  delete giveaways[chatId];
  saveGiveaways();
  ctx.deleteMessage(ctx.message.message_id).catch(() => {});
});

bot.on('callback_query', async ctx => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith('join_')) {
    const channelId = parseInt(data.split('_')[1]);
    const g = giveaways[channelId];
    if (!g) return ctx.answerCbQuery('Giveaway not found or expired.');

    const userId = ctx.from.id;
    const username = ctx.from.username || 'unknown';
    if (g.participants.some(p => p.id === userId)) return ctx.answerCbQuery('Already joined.');

    const now = new Date();
    const joinTime = `${String(now.getUTCDate()).padStart(2, '0')}/${String(now.getUTCMonth()+1).padStart(2, '0')}/${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;

    g.participants.push({ id: userId, username, joinTime });

    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    oauth2Client.setCredentials(JSON.parse(fs.readFileSync('token.json')));
    const sheetId = g.sheetUrl.split('/d/')[1].split('/')[0];
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Participants!A:C',
      valueInputOption: 'RAW',
      requestBody: { values: [[userId, username, joinTime]] }
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
  }

  if (data === 'set_count') {
    config[ctx.from.id] = config[ctx.from.id] || {};
    config[ctx.from.id].state = 'awaiting_count';
    ctx.answerCbQuery();
    ctx.reply('Send the new winner count (number):');
  }

  if (data === 'set_format') {
    config[ctx.from.id] = config[ctx.from.id] || {};
    config[ctx.from.id].state = 'awaiting_format';
    ctx.answerCbQuery();
    ctx.reply('Send your custom winner message format. Use {username} as placeholder.');
  }

  if (data === 'reset_format') {
    config[ctx.from.id] = { count: 10, format: '🎉 Congratulations {username}!' };
    ctx.answerCbQuery();
    ctx.reply('✅ Format reset to default.');
    saveGiveaways();
  }
});

bot.command('config', ctx => {
  const id = ctx.from.id;
  const c = config[id] || { count: 10, format: '🎉 Congratulations {username}!' };
  ctx.reply(`⚙️ Giveaway Configuration:\nWinner Count: ${c.count || 10}\nFormat: ${c.format}`, Markup.inlineKeyboard([
    [Markup.button.callback('Set Winner Count', 'set_count')],
    [Markup.button.callback('Set Custom Format', 'set_format')],
    [Markup.button.callback('Reset to Default', 'reset_format')]
  ]));
});

bot.on('message', ctx => {
  const state = config[ctx.from.id]?.state;
  if (!state) return;

  if (state === 'awaiting_count') {
    const val = parseInt(ctx.message.text);
    if (isNaN(val) || val <= 0) return ctx.reply('❌ Please send a valid number.');
    config[ctx.from.id].count = val;
    delete config[ctx.from.id].state;
    ctx.reply(`✅ Winner count set to ${val}`);
    saveGiveaways();
  }

  if (state === 'awaiting_format') {
    config[ctx.from.id].format = ctx.message.text;
    delete config[ctx.from.id].state;
    ctx.reply('✅ Custom format saved.');
    saveGiveaways();
  }
});

app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
  });
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
  res.send('Manual backup done');
});

// INIT
loadGiveaways();
bot.launch();
app.listen(3000, () => {
  console.log('🚀 Server at http://localhost:3000');
});

cron.schedule('0 0 * * *', () => {
  console.log('📁 Running daily Drive backup...');
  backupToDrive();
});
