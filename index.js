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
let bindings = {};
let userConfigs = {};

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

function loadBindings() {
  try {
    bindings = JSON.parse(fs.readFileSync('bindings.json'));
  } catch {
    bindings = {};
  }
}

function saveBindings() {
  fs.writeFileSync('bindings.json', JSON.stringify(bindings, null, 2));
}

function loadConfigs() {
  try {
    userConfigs = JSON.parse(fs.readFileSync('configs.json'));
  } catch {
    userConfigs = {};
  }
}

function saveConfigs() {
  fs.writeFileSync('configs.json', JSON.stringify(userConfigs, null, 2));
}

function getUserConfig(userId) {
  if (!userConfigs[userId]) {
    userConfigs[userId] = {
      winnerCount: 10,
      customFormat: '🎉 Congratulations {username}!',
      awaitingWinnerCount: false,
      awaitingCustomFormat: false
    };
    saveConfigs();
  }
  return userConfigs[userId];
}

function backupToDrive() {
  if (!fs.existsSync('token.json')) return;
  oauth2Client.setCredentials(JSON.parse(fs.readFileSync('token.json')));
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
    const fileMetadata = { name: 'giveaways.json' };

    if (res.data.files.length > 0) {
      drive.files.update({ fileId: res.data.files[0].id, media }, err => {
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
    if (!fs.existsSync('token.json')) return reject('Missing token.json');
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

bot.on('channel_post', async ctx => {
  const text = ctx.channelPost.text?.trim();
  if (!text?.startsWith('/run')) return;

  const chatId = ctx.chat.id;
  const title = `Giveaway_${chatId}_${Date.now()}`;
  const sheetUrl = await createSheet(title);

  const msg = await ctx.telegram.sendMessage(chatId, `🎉 GIVEAWAY STARTED!\nClick to join using the button below!\n📊 Entries: 0`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📄 View Sheet', url: sheetUrl }],
        [{ text: '✅ Participate', callback_data: `join_${chatId}` }]
      ]
    }
  });

  giveaways[chatId] = {
    message_id: msg.message_id,
    sheetUrl,
    participants: [],
    winnerCount: getUserConfig(chatId).winnerCount || 10,
    format: getUserConfig(chatId).customFormat || '🎉 Congratulations {username}!'
  };

  saveGiveaways();
  try { await ctx.deleteMessage(ctx.channelPost.message_id); } catch {}
});

bot.command('draw', async ctx => {
  const chatId = ctx.chat.id;
  const g = giveaways[chatId];
  if (!g || g.participants.length === 0) return ctx.reply('No participants.');

  const shuffled = fisherYates([...g.participants]);
  const winners = shuffled.slice(0, g.winnerCount);
  const result = winners.map(w => g.format.replace('{username}', `@${w.username}`)).join('\n');

  await ctx.telegram.editMessageReplyMarkup(chatId, g.message_id, null, {
    inline_keyboard: [
      [{ text: '📄 View Sheet', url: g.sheetUrl }],
      [{ text: '⛔ Giveaway Ended', callback_data: 'ended', hide: true }]
    ]
  });

  await ctx.reply(`🏆 WINNER ANNOUNCEMENT 🏆\n${result}`);
  delete giveaways[chatId];
  saveGiveaways();
  try { await ctx.deleteMessage(ctx.message.message_id); } catch {}
});

bot.on('callback_query', async ctx => {
  const id = ctx.callbackQuery.data;
  if (!id.startsWith('join_')) return;

  const channelId = parseInt(id.split('_')[1]);
  const g = giveaways[channelId];
  if (!g) return ctx.answerCbQuery('Giveaway not found.');

  const userId = ctx.from.id;
  if (g.participants.some(p => p.id === userId)) return ctx.answerCbQuery('Already joined.');

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

  await ctx.answerCbQuery('You joined!');
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

bot.command('start', async ctx => {
  if (ctx.chat.type !== 'private') return;
  await ctx.reply('Welcome to MyPicker Bot!\nUse the menu below to configure.', {
    reply_markup: {
      keyboard: [['⚙️ Configure Giveaway'], ['📋 My Bound Channels'], ['🔗 Bind Channel'], ['❌ Unbind Channel'], ['ℹ️ Help']],
      resize_keyboard: true
    }
  });
});

bot.hears('⚙️ Configure Giveaway', async ctx => {
  const cfg = getUserConfig(ctx.from.id);
  await ctx.reply(`⚙️ Giveaway Configuration:\nWinner Count: ${cfg.winnerCount}\nFormat: ${cfg.customFormat}`, {
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
  const cfg = getUserConfig(ctx.from.id);
  cfg.awaitingWinnerCount = true;
  saveConfigs();
  await ctx.reply('Enter number of winners:');
  await ctx.answerCbQuery();
});

bot.action('set_custom_format', async ctx => {
  const cfg = getUserConfig(ctx.from.id);
  cfg.awaitingCustomFormat = true;
  saveConfigs();
  await ctx.reply('Enter format using {username}');
  await ctx.answerCbQuery();
});

bot.action('reset_config', async ctx => {
  userConfigs[ctx.from.id] = {
    winnerCount: 10,
    customFormat: '🎉 Congratulations {username}!',
    awaitingWinnerCount: false,
    awaitingCustomFormat: false
  };
  saveConfigs();
  await ctx.reply('✅ Reset to default.');
  await ctx.answerCbQuery();
});

bot.hears('📋 My Bound Channels', async ctx => {
  const list = Object.entries(bindings)
    .filter(([, id]) => id === ctx.from.id)
    .map(([ch,]) => `• ${ch}`).join('\n') || 'None.';
  await ctx.reply(`🔗 Bound Channels:\n${list}`);
});

bot.hears('🔗 Bind Channel', async ctx => {
  await ctx.reply('Forward a post from your channel to bind it.');
});

bot.hears('❌ Unbind Channel', async ctx => {
  const owned = Object.keys(bindings).filter(k => bindings[k] === ctx.from.id);
  if (owned.length === 0) return ctx.reply('No bound channels found.');
  owned.forEach(ch => delete bindings[ch]);
  saveBindings();
  await ctx.reply('✅ Channels unbound.');
});

bot.on('message', async ctx => {
  const cfg = getUserConfig(ctx.from.id);
  const text = ctx.message.text;
  if (cfg.awaitingWinnerCount && /^\d+$/.test(text)) {
    cfg.winnerCount = parseInt(text);
    cfg.awaitingWinnerCount = false;
    saveConfigs();
    await ctx.reply(`✅ Winner count set to ${cfg.winnerCount}`);
  } else if (cfg.awaitingCustomFormat) {
    cfg.customFormat = text;
    cfg.awaitingCustomFormat = false;
    saveConfigs();
    await ctx.reply(`✅ Format set to:\n${cfg.customFormat}`);
  }

  if (ctx.message.forward_from_chat) {
    const channelId = ctx.message.forward_from_chat.id;
    bindings[channelId] = ctx.from.id;
    saveBindings();
    await ctx.reply(`✅ Channel ${ctx.message.forward_from_chat.title} bound.`);
  }
});

// Boot
loadGiveaways();
loadBindings();
loadConfigs();

bot.launch();
app.listen(3000, () => {
  console.log('🚀 Server running on :3000');
  if (fs.existsSync('token.json')) console.log('✅ Google Sheets ready.');
});

cron.schedule('0 0 * * *', () => {
  console.log('🕒 Daily Google Drive backup...');
  backupToDrive();
});
