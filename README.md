# Discord 24/7 Radio Bot

Un bot Discord simple pour diffuser une webradio 24h/24 avec reconnexion automatique.

## ✨ Fonctionnalités

- 🎵 Diffusion radio 24/7
- 🔄 Reconnexion automatique
- �️ Contrôle du volume
- ⚡ Commandes slash modernes
- 🐳 Compatible Docker

## � Installation rapide

### Avec Docker (recommandé)

1. **Cloner le projet:**
```bash
git clone https://github.com/WildZun/discord-24-7-radio-bot.git
cd discord-24-7-radio-bot
```

2. **Configurer les variables:**
```bash
cp .env.docker .env
# Éditer .env avec ton token Discord et l'URL de la radio
```

3. **Démarrer:**
```bash
docker-compose up -d
```

### Installation classique

1. **Prérequis:** Node.js 18+ et FFmpeg
2. **Installation:**
```bash
git clone https://github.com/WildZun/discord-24-7-radio-bot.git
cd discord-24-7-radio-bot
npm install
cp .env.example .env
# Éditer .env avec tes paramètres
npm start
```

## ⚙️ Configuration

Créer un fichier `.env`:
```env
DISCORD_TOKEN=ton_token_discord
RADIO_URL=https://ton-stream-radio.mp3
```

**Permissions Discord requises:** Connect, Speak, Use Slash Commands, Send Messages

## 🎮 Commandes

| Commande | Description |
|----------|-------------|
| `/play` | Lancer la radio |
| `/stop` | Arrêter la radio |
| `/disconnect` | Déconnecter le bot |
| `/volume <1-100>` | Régler le volume |
| `/info` | Infos système |

## 🐳 Docker

**Démarrer:**
```bash
docker-compose up -d
```

**Voir les logs:**
```bash
docker-compose logs
```

**Arrêter:**
```bash
docker-compose down
```

## 🛠️ Dépannage

- **FFmpeg manquant:** `choco install ffmpeg` (Windows) ou `sudo apt install ffmpeg` (Linux)
- **Erreurs Opus:** `npm install opusscript`
- **Windows ARM:** `npm install --no-optional`

## 📝 Licence

MIT License - voir [LICENSE](LICENSE)

## 👨‍💻 Auteur

**WildZun** - [@WildZun](https://github.com/WildZun) - Discord: @wildzun

**Support:** [Issues GitHub](https://github.com/WildZun/discord-24-7-radio-bot/issues) | [Discord](https://discord.wildzun.fr)