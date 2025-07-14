# Discord 24/7 Radio Bot

A simple Discord bot for 24/7 webradio streaming with automatic reconnection, built with Discord.js v14.

## Features

- ✅ **24/7 Streaming**: Bot stays connected permanently to voice channels
- 🔄 **Auto-Reconnection**: Automatic recovery from network issues
- 🎵 **Modern Slash Commands**: Uses Discord's latest slash command system  
- 🔊 **Volume Control**: Adjustable volume levels (1-100%)
- ⏸️ **Playback Controls**: Play, stop, pause, resume, restart
- 🏗️ **ARM Compatible**: Optimized for Windows ARM and other architectures
- 📊 **Status Monitoring**: Real-time status and system information
- 🛠️ **Error Recovery**: Robust error handling with automatic retries

## Prerequisites

- **Node.js 18+** 
- **FFmpeg** installed and in system PATH
- **Discord Bot Token** from [Discord Developer Portal](https://discord.com/developers/applications)

## Installation

1. **Clone the repository:**
```bash
git clone https://github.com/WildZun/discord-24-7-radio-bot.git
cd discord-24-7-radio-bot
```

2. **Install dependencies:**
```bash
npm install
```

3. **Configure environment:**
Create a `.env` file in the root directory:
```env
DISCORD_TOKEN=your_discord_bot_token_here
RADIO_URL=https://your-radio-stream.mp3
```

4. **Start the bot:**
```bash
npm start
```

For development with auto-restart:
```bash
npm run dev
```

## Commands

| Command | Description |
|---------|-------------|
| `/play` | Start the webradio in 24/7 mode |
| `/stop` | Stop the radio (but stay connected) |
| `/disconnect` | Completely disconnect from voice channel |
| `/pause` | Pause the webradio |
| `/resume` | Resume webradio playback |
| `/restart` | Restart the webradio stream |
| `/volume <1-100>` | Adjust volume level |
| `/status` | Show current status |
| `/info` | Show system information |

## Configuration

### Environment Variables

- `DISCORD_TOKEN`: Your Discord bot token
- `RADIO_URL`: URL of your webradio stream (MP3/HTTP stream)

### Bot Permissions

Your Discord bot needs these permissions:
- Connect
- Speak  
- Use Slash Commands
- Send Messages

## Architecture Support

- **Windows ARM**: Fully supported with opusscript
- **Windows x64**: Supported
- **Linux**: Supported
- **macOS**: Supported

## Troubleshooting

### FFmpeg Issues
```bash
# Windows (with Chocolatey)
choco install ffmpeg

# macOS (with Homebrew)  
brew install ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg
```

### Opus Encoder Issues
```bash
npm install opusscript --save
```

### Windows ARM Specific
If you encounter compilation errors, use:
```bash
npm install --no-optional
```

## Development

### Project Structure
```
├── index.js              # Main bot file
├── package.json        # Dependencies and scripts
├── .env               # Environment variables (create this)
├── README.md          # Documentation
└── .gitignore         # Git ignore rules
```

### Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Commit changes: `git commit -am 'Add feature'`
4. Push to branch: `git push origin feature-name`
5. Submit a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- Create an [Issue](https://github.com/WildZun/discord-24-7-radio-bot/issues) for bug reports
- Join our [Discord Server](https://discord.wildzun.fr) for support
## Author

**WildZun**
- GitHub: [@WildZun](https://github.com/WildZun)
- Discord: @wildzun

## Acknowledgments

- [Discord.js](https://discord.js.org/) - Powerful Discord API library
- [@discordjs/voice](https://github.com/discordjs/voice) - Voice connection library
- [FFmpeg](https://ffmpeg.org/) - Multimedia framework