# Discord 24/7 Radio Bot

Un bot Discord simple pour diffuser une webradio 24h/24 avec reconnexion automatique.

## ✨ Fonctionnalités

- 🎵 Diffusion radio 24/7
- ⏸️ Flux suspendu quand le salon vocal est vide, repris au prochain join
- 🔄 Reconnexion automatique
- �️ Contrôle du volume
- ⚡ Commandes slash modernes
- 🐳 Compatible Docker
- 💾 Reprise automatique des salons radio après redémarrage

L'image Docker utilise FFmpeg Debian. Installation Node utilise `ffmpeg-static`.

## � Installation rapide

### Avec Docker (recommandé)

**Option 1: Docker Compose**
1. **Cloner projet:**
```bash
git clone https://github.com/WildZun/discord-24-7-radio-bot.git
cd discord-24-7-radio-bot
```

2. **Configurer:**
```bash
cp .env.docker .env
# Éditer .env avec ton token Discord et l'URL de la radio
```

3. **Démarrer:**
```bash
docker compose up -d
```

La base SQLite est conservée dans `./data/radio-bot.sqlite`.

**Option 2: Docker direct**
1. **Créer le fichier .env:**
```bash
echo "DISCORD_TOKEN=ton_token_discord" > .env
echo "RADIO_URL=https://ton-stream-radio.mp3" >> .env
```

2. **Construire et démarrer container:**
```bash
docker build -t discord-24-7-radio-bot .
docker run -d \
  --name discord-radio-bot \
  --env-file .env \
  --restart unless-stopped \
  --init \
  discord-24-7-radio-bot
```

**Option 3: Docker avec variables directes**
```bash
docker build -t discord-24-7-radio-bot .
docker run -d \
  --name discord-radio-bot \
  -e DISCORD_TOKEN=ton_token_discord \
  -e RADIO_URL=https://ton-stream-radio.mp3 \
  --restart unless-stopped \
  --init \
  discord-24-7-radio-bot
```

### Installation classique

1. **Prérequis:** Node.js 22.12+ (FFmpeg est installé avec les dépendances npm)
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

## 🛠️ Dépannage

### Rate limiting et reconnexions

- `/play` dans le salon déjà actif ne recrée pas la connexion. Les commandes et la restauration sont sérialisées par serveur ; un changement de salon est limité à un toutes les 5 secondes.
- Les erreurs asynchrones utilisent un backoff exponentiel de 10 secondes à 5 minutes, avec jitter. Seules 30 secondes de lecture saine réinitialisent ce backoff. Les événements mute/deafen ne contournent pas les délais.
- La récupération du vocal attend l'état Ready. Un kick Discord (4014) arrête la session si aucune récupération de déplacement n'est possible, sans boucle de rejoin.
- Les notifications d'erreur sont limitées à une par serveur/minute et une par seconde pour le processus. Un salon inaccessible est retiré des notifications.
- FFmpeg est vérifié avant le login Discord. Les commandes sont réenregistrées uniquement si leur définition change.
- `discord_rate_wait` indique une attente SDK ; `discord_http_error` indique une erreur HTTP réelle avec scope, bucket, route anonymisée et `Retry-After`. Les 429 sans délai exploitable échouent au lieu d'être réessayés en boucle.

Tests hors ligne et contrôle de syntaxe :

```bash
npm test
npm run check
```

Pour appliquer le code local au déploiement Compose existant :

```bash
docker compose build radio-bot
docker compose up -d --no-deps radio-bot
docker compose logs -f radio-bot
```

Le service `init-data` reste utilisé pour une première installation. La reconstruction locale conserve `./data/radio-bot.sqlite`. Un simple redémarrage d'une ancienne image GHCR ne charge pas les correctifs.

- **FFmpeg:** fourni par `ffmpeg-static` lors de `npm install`
- **Erreurs Opus:** `npm install opusscript`
- **Windows ARM:** `npm install --no-optional`

## 📝 Licence

MIT License - voir [LICENSE](LICENSE)

## 👨‍💻 Auteur

**WildZun** - [@WildZun](https://github.com/WildZun) - Discord: @wildzun

**Support:** [Issues GitHub](https://github.com/WildZun/discord-24-7-radio-bot/issues) | [Discord](https://discord.wildzun.fr)
