# Music Bot Duo

Two Discord music bots run from one folder. They share a local SQLite playlist and media cache database. Each bot has its own Discord token, prefix, voice queue, and DJ and log settings.

## Setup

1. Install Node.js 24.17 or newer, FFmpeg, and yt-dlp. Put the executables on PATH or set their paths in each profile. Run `npm ci` in this folder.
2. Create two Discord applications and enable **Message Content Intent** for both. Invite each bot with the `bot` scope. The bot needs View Channels, Send Messages, Embed Links, Read Message History, Connect, and Speak in the relevant channels.
3. Copy `.env.example` to both `.env.bot1` and `.env.bot2`. Set a different `DISCORD_TOKEN` in each. Set `PREFIX=">"` for Bot 1 and `PREFIX="!"` for Bot 2.
4. On Windows, run **Start Music Bot.bat**. On a terminal with the required tools installed, run `npm start`. Wait for both profiles to report ready and use `>help` and `!help` in Discord.

**Stop Music Bot.bat** stops both local workers. Ctrl+C requests graceful shutdown. The Windows BAT files accept `-CheckOnly` for a preflight or status check. This pair runs through `src/run.js`.

## Shared state

The first run creates `data/music-shared.sqlite`. Saved playlists and compatible Spotify and YouTube cache entries are shared. Played-track cleanup protects current and upcoming tracks in both workers. Cache buckets separate incompatible provider account settings. The two bots keep independent live voice queues. Their DJ, log, and prefix settings live in separate files under `data/`.

Keep `.env.bot1`, `.env.bot2`, `secrets/`, and `data/` private. Optional YouTube cookie paths and Spotify search credentials belong in each profile. Create a private backup of the database before moving hosts. The production owner ID for process commands and playlist beta access is defined in `src/config/owner.js`.

Run `npm test` and `npm run check` to verify the source.
