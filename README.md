# Discord Music Duo

Run two Discord music bots from one project folder. The bots share saved playlists and compatible lookup caches while keeping their voice sessions and server settings separate.

**Proprietary software. Written permission is required to run, reuse, modify, or redistribute the original project.** See [LICENSE](LICENSE).

## How the pair works

| Shared by both bots | Separate for each bot |
| --- | --- |
| Owner-only saved playlists | Discord token and default prefix |
| Compatible cached Spotify and YouTube lookups | Live queue, playback, and voice connections |
| One local SQLite database | Server prefix overrides, DJ channel, log channel, and player message IDs |

`src/run.js` reads `.env.bot1` and `.env.bot2`, then starts a supervised worker for each profile. The database is created at `data/music-shared.sqlite`.

For one bot account, see [Discord Music Bot](https://github.com/mmaarij123/discord-music-bot).

## Music features

- Song searches, individual YouTube videos, and supported public YouTube playlists.
- Public Spotify tracks, albums, and playlists matched to supported YouTube audio.
- Queue controls, interactive player buttons, skip voting, volume, repeat, and optional autoplay.
- One reusable player message in a configured DJ channel.
- Per-server prefixes and separate playback logs.

## Requirements

- Node.js **24.17.0 or newer** and npm.
- FFmpeg available as an executable.
- A current official yt-dlp release with its EJS component.
- Discord bot tokens and permission to install the bots in your servers.
- A host that allows long-running Node processes, child processes, and Discord voice traffic.

Install the runtime and audio tools before starting the bot. Verify them from a terminal.

```bash
node --version
ffmpeg -version
yt-dlp --version
```

Use the official installation guides for your operating system. The official yt-dlp executables include EJS. The bot passes its Node executable to yt-dlp for JavaScript support.

[Node.js downloads](https://nodejs.org/en/download) · [FFmpeg downloads](https://ffmpeg.org/download.html) · [yt-dlp installation](https://github.com/yt-dlp/yt-dlp/wiki/Installation) · [yt-dlp EJS setup](https://github.com/yt-dlp/yt-dlp/wiki/EJS)

## Discord setup

1. Open the Discord Developer Portal and create two applications, each with its own bot.
2. For both bots, enable **Message Content Intent** on the Bot page.
3. Save each token in the corresponding private profile file.
4. Invite each bot with the `bot` scope and the permissions below.

Give the bot **View Channels**, **Send Messages**, **Embed Links**, **Read Message History**, **Connect**, and **Speak** in the channels it uses. Threads need **Send Messages in Threads**.

Use regular voice channels for playback. Configure the DJ and log channels with the prefix commands after the bot is online.

[Discord Developer Portal](https://discord.com/developers/applications) · [Message Content Intent](https://docs.discord.com/developers/events/gateway#message-content-intent)

## Installation

After obtaining permission to run the project, clone it and install its dependencies.

```bash
git clone https://github.com/mmaarij123/discord-music-duo.git
cd discord-music-duo
npm ci
```

Make two copies of `.env.example` using your file manager. Name them `.env.bot1` and `.env.bot2`.

Edit `.env.bot1`.

```env
DISCORD_TOKEN=your_first_bot_token
PREFIX=">"
FFMPEG_PATH=ffmpeg
YTDLP_PATH=yt-dlp
```

Edit `.env.bot2`.

```env
DISCORD_TOKEN=your_second_bot_token
PREFIX="!"
FFMPEG_PATH=ffmpeg
YTDLP_PATH=yt-dlp
```

Use distinct real bot tokens and distinct default prefixes. Each profile needs its own settings, including any optional Spotify credentials or tool paths it uses. The pair's startup reads these two files.

Validate the profiles before connecting to Discord.

```bash
node src/run.js --check
```

Start both bots from the project folder.

```bash
npm start
```

Wait for both `bot1` and `bot2` to report `Bot ready`. Then use the appropriate prefix in Discord.

```text
>play Stephen Sanchez Until I Found You
!play Stephen Sanchez Until I Found You
>help
!help
```

Press Ctrl+C in the parent terminal to request shutdown of both workers.

## Commands

The commands are the same for both bots. Use the prefix of the bot you want to control. A server can store its own prefix override for each bot.

| Command | What it does |
| --- | --- |
| `play <song or link>` | Play a song or add it to the queue. |
| `pause` / `resume` | Pause or continue the current song. |
| `skip` | Skip a song you requested, or open a vote for another person's song. |
| `stop` | Stop music, empty the queue, and leave voice. |
| `queue [page]` | Show upcoming songs. |
| `nowplaying` | Show the current song or point to the configured DJ channel. |
| `volume <0–100>` | Change playback volume. |
| `loop <off\|track\|queue>` | Turn repeat off, repeat the song, or repeat the queue. |
| `shuffle` | Shuffle upcoming songs. |
| `remove <position>` | Remove an upcoming song by its queue position. |
| `join` / `leave` | Join your voice channel or disconnect and clear the queue. |
| `autoplay <on\|off>` | Enable or disable related songs when the queue ends. Requires Manage Server. |
| `logchannel [#channel\|off]` | View, set, or reset the playback log channel. Requires Manage Server. |
| `djchannel [#channel\|off]` | View, set, or reset the permanent music player channel. Requires Manage Server. |
| `prefix [characters]` | View the prefix. Administrators can set a prefix of one or two characters. |
| `help` | Show the command guide. |

Skip votes use a majority of the human listeners who were in voice when the vote opened. Votes have a 60-second deadline.

## Owner controls

The owner account is set by `OWNER_USER_ID` in `src/config/owner.js`. For an authorized deployment, set it to your Discord user ID before starting.

| Command | What it does |
| --- | --- |
| `clearcache` | Clear played-song cache entries while protecting current and upcoming tracks. |
| `shutdown` | Shut down the receiving bot across its servers. |
| `restart` | Restart the receiving bot through the startup supervisor. |

These commands and all personal playlist beta commands require the configured owner account.

Each profile has its own worker. An owner command sent to one bot controls that worker. Ctrl+C in the parent process requests shutdown of both.

Voice sessions and in-memory queues reset when a worker restarts.

## Personal playlists

Personal playlists are a beta feature restricted to the configured bot owner. Each user can have one unnamed playlist.

| Command | What it does |
| --- | --- |
| `playlist create` | Create your playlist. |
| `playlist add <song or link>` | Save a song to your playlist. |
| `playlist save` | Save the song currently playing. |
| `playlist import <Spotify playlist link>` | Import the Spotify tracks that can be retrieved. |
| `playlist play` | Add your saved playlist to the music queue. |
| `playlist show [page]` | Browse your saved songs. |
| `playlist remove <position>` | Remove a saved song. |
| `playlist delete` | Delete your playlist. |

Playlist imports can be partial because of public availability, unsupported entries, duplicates, or configured limits.

Saved playlists are available to the same user across both bots and across their servers through the shared database. The beta owner restriction applies on both profiles.

## Configuration

Set the following in each profile file. The default Spotify-link and YouTube flow uses public lookups without Spotify or YouTube API credentials.

| Setting | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | empty | Private Discord token for this profile. The two values must differ. |
| `PREFIX` | `>` | Default prefix for this profile. Set a different value for Bot 2, such as `!`. |
| `DEFAULT_VOLUME` | `70` | Starting playback volume from 0 to 100. |
| `MAX_QUEUE_LENGTH` | `500` | Maximum upcoming tracks per server. |
| `MAX_PLAYLIST_TRACKS` | `100` | Maximum tracks requested in one collection import. |
| `MAX_SAVED_PLAYLIST_TRACKS` | `500` | Maximum tracks in a saved personal playlist. |
| `IDLE_TIMEOUT_SECONDS` | `300` | Delay before an idle session leaves voice. |
| `AUTOPLAY_ENABLED` | `false` | Initial related-song autoplay setting. |
| `ENABLE_247_MODE` | `false` | Keep an idle voice connection while the process runs. |
| `LOG_LEVEL` | `info` | Use `debug`, `info`, `warn`, or `error`. |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg command name or full executable path. |
| `YTDLP_PATH` | `yt-dlp` | yt-dlp command name or full executable path. |

### Optional settings

| Settings | Purpose |
| --- | --- |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Enable optional official Spotify text search. Set both together. |
| `SPOTIFY_MARKET` | Optional two-letter country code for Spotify search, such as `PK`. |
| `SEARCH_CACHE_SECONDS` | Lifetime of cached search results. Default `900`. |
| `AUDIO_SOURCE_CACHE_SECONDS` | Lifetime of cached audio source links. Default `300`. |
| `METADATA_CONCURRENCY` | Parallel lookup limit. Default `2`. |
| `PROCESS_TIMEOUT_SECONDS`, `SPOTIFY_DISCOVERY_TIMEOUT_MS` | Tool and Spotify search deadlines. |
| `MAX_TRACK_SECONDS`, `MAX_PLAYERS` | Track duration and active server limits. Defaults `7200` and `20`. |
| `AUDIO_STALL_TIMEOUT_SECONDS`, `PLAYBACK_RETRY_LIMIT` | Bounded audio recovery settings. Defaults `20` and `2`. |
| `YOUTUBE_FAST_EXTRACTION` | Optional extraction setting. Default `false`. |
| `MEDIA_ROOT`, `MEDIA_MANIFEST` | Paths for your authorized local media library. |
| `YOUTUBE_COOKIES_FILE` | Optional private Netscape-format cookie file inside `secrets/`. |
| `SPOTIFY_SEARCH_ADAPTER`, `RECOMMENDATION_ADAPTER` | Paths to trusted, operator-provided ESM adapters. |

Use `.env.example` for the full configuration template. Keep tokens, Spotify secrets, cookie exports, and runtime data out of commits and shared logs.

Optional cookie files carry account session data. Configure them privately on the host when authorized. Login, age, region, and other provider restrictions can still make a source unavailable.

## Saved state and cache

| Path | Purpose |
| --- | --- |
| `data/music-shared.sqlite` | Shared saved playlists and compatible provider lookup caches. |
| `data/guild-settings.bot1.json` | Bot 1 server settings and player message IDs. |
| `data/guild-settings.bot2.json` | Bot 2 server settings and player message IDs. |
| `.env.bot1`, `.env.bot2` | Private per-profile configuration. |

The cache holds lookup results and short-lived source links. Audio is resolved when needed and streamed through the audio pipeline. The shared cache separates provider settings when entries are incompatible.

Played-song cleanup protects current and upcoming track keys from both workers. Live queues and history remain in each worker's memory and reset when that worker restarts.

Keep the pair on one host with a writable persistent data directory. Back up the database when both workers are stopped. Keep any SQLite journal or companion files with the database while it is in use.

## Hosting

Choose a host that permits two bot accounts and their child processes in one deployment.

| Panel field | Value |
| --- | --- |
| Startup command | `npm start` or `node src/run.js` |
| Main JavaScript file | `src/run.js` |
| Runtime | Node.js 24.17+ |
| Private profile files | `.env.bot1` and `.env.bot2` |
| Persistent directory | `data/` |

Install FFmpeg and yt-dlp on the host. Set their paths in both profiles. A hosted Linux yt-dlp installation might use `YTDLP_PATH=/home/container/bin/yt-dlp`. Test the executable directly with `--version` before starting the pair.

Run `npm ci` on the target operating system. Keep one DUO group per data directory and one active worker per bot token. Startup messages include the profile name so you can tell which bot is reporting a problem.

## Checks and updates

```bash
npm run check
npm test
```

These run JavaScript syntax checks and automated tests. Most external services and voice sessions are mocked in the test suite. Validate real playback separately by joining a test voice channel and playing an authorized source.

Check each profile's local tool configuration separately.

```bash
node --env-file=.env.bot1 scripts/doctor.js
node --env-file=.env.bot2 scripts/doctor.js
```

To update an authorized deployment, stop the process, back up private configuration and saved data, pull the code, run `npm ci`, run the checks, and start it again.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `EBADENGINE` or unsupported syntax | Select Node.js 24.17+ in the host's runtime settings. |
| Process exits immediately | Use `npm start` or `node src/run.js`, then read the first startup error. |
| Profile errors before startup | Both `.env.bot1` and `.env.bot2` must exist and contain distinct tokens and distinct default prefixes. |
| Prefix commands get no response | Enable Message Content Intent and check the server prefix and channel permissions. |
| FFmpeg or yt-dlp cannot start | Run its version command directly on the host and check the configured executable path. |
| YouTube playback is denied | Check the exact source, current yt-dlp/EJS installation, and provider availability on the host's network. |
| Spotify collection imports fewer songs | Check the import limit and whether those entries are publicly available. |
| No audio or a voice timeout | Check Connect/Speak, server mute, channel capacity, volume, and host UDP support. |
| DJ player card is missing | Check the selected channel and Read Message History permission. |
| `database is locked` | Check for other processes or database editors using `data/music-shared.sqlite`. Use one DUO group per data directory on a persistent local filesystem. |

Queue positions start at 1. Session controls normally require the user's voice channel to match the bot's. The session host or a member with Manage Server can use `stop` or `leave` from outside voice.

Source availability depends on the provider. Spotify links supply track information, and available tracks are matched to supported YouTube sources. Local and direct-stream library entries must be configured by the operator with permission to use the media.

## Project layout

```text
src/
  run.js               Starts and supervises the two workers
  index.js             Connects one configured worker to Discord
  commands/            Prefix commands and skip voting
  components/          Player cards and buttons
  config/              Settings and owner access
  music/               Audio, discovery, queues, and shared SQLite state
  utils/               Logging, process cleanup, and request limits
scripts/               Diagnostics and validation
tests/                 Automated tests
.env.example           Configuration template
package.json           Dependencies and startup commands
LICENSE                Terms for the original project
```

## License

Copyright © 2026 Maarij (@mmaarij123). All rights reserved.

The original project is proprietary. Running, modifying, reusing, or redistributing it requires prior written permission from the copyright holder, subject to applicable law and platform terms. Third-party materials retain their own license terms.

Public source availability allows inspection. See [LICENSE](LICENSE) for the full terms. The setup instructions above describe an authorized deployment.
