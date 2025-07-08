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
let channelConfig = {};

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
    const media = {
      mimeType: 'application/json',
      body: fs.createReadStream('giveaways.json')
    };
    if (res.data.files.length > 0) {
      drive.files.update({ fileId: res.data.files[0].id, media }, err => {
        if (err) console.error('Drive update error:', err);
      });
    } else {
      drive.files.create({ resource: { name: 'giveaways.json' }, media, fields: 'id' }, err => {
        if (err) console.error('Drive create error:', err);
      });
    }
  });
}

app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file'
    ]
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  fs.writeFileSync('token.json', JSON.stringify(tokens));
  res.send('✅ Authorization successful. You can close this tab.');
});

app.get('/backup', (req, res) => {
  backupToDrive();
  res.send('✅ Manual backup triggered.');
});

function createSheet(title) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync('token.json')) return reject('No token');
    oauth2Client.setCredentials(JSON.parse(fs.readFileSync('token.json')));
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    sheets.spreadsheets.create({
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

function fisherYates(array) {
  const buf = Buffer.alloc(array.length * 4);
  crypto.randomFillSync(buf);
  for (let i = array.length - 1; i > 0; i--) {
    const j = buf.readUInt32LE(i * 4) % (i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Command: /run (channel only)
bot.on('channel_post', async ctx => {
  const text = ctx.channelPost.text?.trim();
  const channelId = ctx.channelPost.chat.id;

  if (text === '/run') {
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
      winnerCount: channelConfig[channelId]?.winnerCount || 10,
      format: channelConfig[channelId]?.format || '🎉 Congratulations {username}!',
    };

    saveGiveaways();
    await ctx.deleteMessage(ctx.channelPost.message_id).catch(() => {});
  }

  if (text?.toLowerCase() === '/draw') {
    const g = giveaways[channelId];
    if (!g || g.participants.length === 0) return ctx.telegram.sendMessage(channelId, '❌ No participants found.');

    const shuffled = fisherYates([...g.participants]);
    const winners = shuffled.slice(0, g.winnerCount);
    const result = winners.map(w => g.format.replace('{username}', `@${w.username}`)).join('\n');

    await ctx.telegram.editMessageReplyMarkup(channelId, g.message_id, null, {
      inline_keyboard: [
        [{ text: '📄 View Sheet', url: g.sheetUrl }],
        [{ text: '⛔ Giveaway Ended', callback_data: 'ended' }]
      ]
    });

    await ctx.telegram.sendMessage(channelId, `🏆 WINNER ANNOUNCEMENT 🏆\n${result}`);
    delete giveaways[channelId];
    saveGiveaways();
    await ctx.deleteMessage(ctx.channelPost.message_id).catch(() => {});
  }
});

bot.on('callback_query', async ctx => {
  const id = ctx.callbackQuery.data;
  if (!id.startsWith('join_')) return;
  const channelId = parseInt(id.split('_')[1]);
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
});

bot.command('start', ctx => {
  if (ctx.chat.type !== 'private') return;
  ctx.reply('🎉 Welcome to MyPickerBot!\nUse the buttons below to manage your giveaways.', {
    reply_markup: {
      keyboard: [
        ['⚙️ Configure Giveaway'],
        ['📋 My Bound Channels']
      ],
      resize_keyboard: true
    }
  });
});

bot.hears('⚙️ Configure Giveaway', async ctx => {
  const cid = ctx.from.id;
  const config = channelConfig[cid] || { winnerCount: 10, format: '🎉 Congratulations {username}!' };
  await ctx.reply(`⚙️ Giveaway Configuration:\nWinner Count: ${config.winnerCount}\nFormat: ${config.format}`, {
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
  channelConfig[ctx.from.id] = channelConfig[ctx.from.id] || {};
  channelConfig[ctx.from.id].awaitingWinnerCount = true;
  await ctx.reply('Enter number of winners:');
  await ctx.answerCbQuery();
});

bot.action('set_custom_format', async ctx => {
  channelConfig[ctx.from.id] = channelConfig[ctx.from.id] || {};
  channelConfig[ctx.from.id].awaitingCustomFormat = true;
  await ctx.reply('Enter winner format using {username}:');
  await ctx.answerCbQuery();
});

bot.action('reset_config', async ctx => {
  channelConfig[ctx.from.id] = { winnerCount: 10, format: '🎉 Congratulations {username}!' };
  await ctx.reply('✅ Configuration reset.');
  await ctx.answerCbQuery();
});

bot.on('message', async ctx => {
  const id = ctx.from.id;
  const msg = ctx.message.text;

  if (channelConfig[id]?.awaitingWinnerCount) {
    const n = parseInt(msg);
    if (n > 0 && n <= 100) {
      channelConfig[id].winnerCount = n;
      channelConfig[id].awaitingWinnerCount = false;
      await ctx.reply(`✅ Winner count set to ${n}`);
    } else {
      await ctx.reply('❌ Please enter a valid number between 1-100');
    }
  }

  if (channelConfig[id]?.awaitingCustomFormat) {
    channelConfig[id].format = msg;
    channelConfig[id].awaitingCustomFormat = false;
    await ctx.reply(`✅ Custom format set:\n${msg}`);
  }
});

// Init
loadGiveaways();
bot.launch();
app.listen(3000, () => {
  console.log('🚀 Server running at http://localhost:3000');
  if (fs.existsSync('token.json')) console.log('✅ Google Sheets authorized!');
});

cron.schedule('0 0 * * *', () => {
  console.log('🕒 Daily Drive backup...');
  backupToDrive();
});
