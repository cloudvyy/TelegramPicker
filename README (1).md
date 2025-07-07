# 🎁 TelePicker Bot – Fair Telegram Giveaway Picker

A powerful Telegram bot to run fair and transparent giveaways using Google Sheets – with no manual participant tracking. Created for maximum ease, privacy, and trust using the [Fisher-Yates Shuffle](https://en.wikipedia.org/wiki/Fisher–Yates_shuffle) algorithm for fairness.

## ✨ Features

- ✅ Run giveaways in your channel using `/run`
- 🔗 Bind/unbind channels in private chat
- 📋 Google Sheets auto-created with headers: `User ID`, `Username`, `Join Time`
- ⏱ Join time recorded in UTC: `dd/mm/yyyy HH:MM UTC`
- ⚙️ Configure winner announcement format
- 👥 Join via inline **Participate** button
- 📈 Live entry count + public sheet link
- 🎉 Fair winner selection using Fisher-Yates shuffle (unbiased)
- 🔐 Sheet is **publicly readable** — no login required
- 🧼 Automatically deletes `/run` and `/draw` command after posting
- ❌ Closes participation after winners drawn

## 🚀 Try It Live

👉 [@MyPickerBot](https://t.me/MyPickerBot)

## 💡 How It Works

1. DM `/start` to the bot.
2. Use **"🔗 Bind Channel"** → Forward any message from your channel.
3. Use `/run` in the channel to start a giveaway.
4. View live entries in Google Sheets.
5. Use `/draw` in the channel to pick winners.

## 🔒 Fairness: Fisher-Yates Algorithm

This bot uses the **Fisher-Yates Shuffle** for random winner selection. Unlike biased sorting or last-clicked entries, this method ensures **every participant has an equal chance**. Verified for unbiased randomness.

> The Fisher-Yates shuffle randomly permutes the participant list by swapping entries from the end toward the beginning using a secure random index. It is the gold standard in fair random selection.

## 🆓 Zero-Cost Deployment

Deploy on **Railway** without credit card:

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/your-referral-link)

Or use this referral link for bonus:  
**🔗 [railway.app?referral=your-user](https://railway.app?referral=your-user)**

> 📝 Don't forget to authorize Google Sheets (visit `/auth`) once deployed.

## 🛠 .env Setup

```env
BOT_TOKEN=your_bot_token
CLIENT_ID=your_google_client_id
CLIENT_SECRET=your_google_client_secret
REDIRECT_URI=https://your-railway-app.up.railway.app/oauth2callback
```

## 📄 License

MIT © [YourName or Project]