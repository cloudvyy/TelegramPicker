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

  if (ctx.message.text === '⚙️ Configure Giveaway') return showConfigMenu(ctx);
  if (ctx.message.text === '🔗 Bind Channel') return ctx.reply('📢 Forward a message from your channel to bind.');
  if (ctx.message.text === '❌ Unbind Channel') {
    const removed = [...boundChannels.entries()].filter(([_, uid]) => uid === userId);
    removed.forEach(([id]) => boundChannels.delete(id));
    return ctx.reply(removed.length ? '✅ Unbound all channels.' : '⚠️ No channels bound.');
  }

  if (ctx.message.text === '📋 My Bound Channels') {
    const list = [...boundChannels.entries()].filter(([_, uid]) => uid === userId).map(([id]) => `📢 ${id}`);
    return ctx.reply(list.length ? `📋 Your bound channels:
${list.join('
')}` : '⚠️ No channels bound.');
  }

  if (ctx.message.text === 'ℹ️ Help') {
    return ctx.reply(`🧩 Help:
Use ⚙️ Configure Giveaway to customize format
Then use /run in your channel to start.`);
  }

  if (ctx.message.forward_from_chat) {
    boundChannels.set(ctx.message.forward_from_chat.id, userId);
    return ctx.reply('✅ Channel bound successfully.');
  }
});

# Other code continues...
