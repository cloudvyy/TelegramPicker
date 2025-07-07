# 🎁 TelePicker Giveaway Bot

A **Telegram giveaway bot** that lets channel owners run fair giveaways using public Google Sheets. Participants can join via inline button, and admins can draw winners using a fair and verifiable algorithm.

---

## 🚀 Features

- ✅ `/run` in your Telegram channel to launch giveaways
- ✅ `/draw` to pick winners (uses fair shuffle)
- ✅ Participations logged in a **Google Sheet** (public viewable)
- ✅ Google Sheets auto-created with:
  - `User ID`, `Username`, `Join Time (UTC)`
- ✅ DM Configuration: set custom winner message format
- ✅ Bound channels per user
- ✅ Automatically deletes `/run` and `/draw` commands after execution
- ✅ Entries update in real-time
- ✅ No Canvas or GUI dependencies — clean text-based logic
- ✅ Ready for **free Railway deploy**

---

## 📦 Setup

1. **Clone this repo** or click deploy button below.
2. Set these env variables:

```
BOT_TOKEN=your_bot_token
CLIENT_ID=your_google_client_id
CLIENT_SECRET=your_google_client_secret
REDIRECT_URI=https://your-app.up.railway.app/oauth2callback
```

3. Run locally:

```bash
npm install
node index.js
```

4. Visit `http://localhost:3000/auth` and authorize your Google account once. This will generate `token.json`.

---

## 📊 How It Works

- Run `/run` in a bound channel → creates a Google Sheet + join button
- Users click “✨ Participate” → logs entry with UTC timestamp
- Use `/draw` in channel → bot selects winners using a **fair random method**

---

## 🧮 Fairness: Fisher-Yates Shuffle

This bot uses **Fisher–Yates Shuffle**, proven to be one of the fairest random algorithms.

> 🔐 `crypto.randomBytes()` is used for secure randomness.  
> 🔄 Every participant has **equal chance**, and all permutations are equally likely.

Why this matters:
- Avoids biases seen in poorly implemented `Math.random()`
- Ensures true randomness on every draw
- Reproducible, fair, and trusted in competitive systems

---

## 🛡️ Security & Privacy

- Google Sheets are **publicly readable** but never editable by users
- Bot does **not store passwords or sensitive data**
- Admins control all draws and visibility

---

## 🧪 Example Custom Winner Format

In DM, use:

```
📝 Set Custom Format:
🏆 Total {count} Winners 🎉
{winners}
```

It will be rendered like:

```
🏆 Total 3 Winners 🎉
1. @john
2. @alice
3. @bob
```

---

## 🧵 Bound Channels

You must bind your channel by forwarding a post to the bot in DM. Then `/run` and `/draw` work only in that channel.

---

## 🆓 One-Click Railway Deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?templateRepo=https://github.com/yourusername/telepicker-bot)

---

## ✅ Conclusion

TelePicker ensures:
- Transparent entry logging (Google Sheets)
- Real-time entry counts
- Secure winner selection using a **verified shuffle**
- No bias, no manipulation

Perfect for giveaways, raffles, contests — where trust and fairness matter.

---

## 📎 License

MIT