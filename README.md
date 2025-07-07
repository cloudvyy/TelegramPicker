# Telegram Giveaway Bot

Telegram bot to run giveaways and export participants to Google Sheets.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/-eRixv?referralCode=BOTLAUNCH&envs=BOT_TOKEN,CLIENT_ID,CLIENT_SECRET,REDIRECT_URI&optionalEnvs=)

## 🧾 Features

- `/run` to start giveaway in your channel
- Participants click button to join
- Entries auto-logged to public Google Sheet
- `/draw` to pick random winners
- Configure custom winner format

## 📦 Environment Variables

- `BOT_TOKEN` - Telegram Bot Token
- `CLIENT_ID` - Google OAuth2 Client ID
- `CLIENT_SECRET` - Google OAuth2 Secret
- `REDIRECT_URI` - Should match https://yourproject.up.railway.app/oauth2callback

---

✅ Deploy for free using Railway button above.
