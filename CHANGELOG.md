# Changelog - Wagoo Desktop

Toutes les modifications notables du projet seront documentées dans ce fichier.

---

## [1.0.0] - 2026-01-06

### 🎉 Lancement Initial

**Wagoo Desktop v1.0.0** est la première version stable et prête pour la production.

### ✨ Fonctionnalités

#### 🎯 Core Features
- ✅ **Fenêtre principale** avec design moderne et responsive
- ✅ **Icône système (Tray)** avec menu contextuel
- ✅ **Adaptation thème** (clair/sombre) automatique
- ✅ **Notifications système** en temps réel
- ✅ **Gestion des deeplinks** `wagoo://` pour les intégrations
- ✅ **Démarrage automatique** au boot du système

#### 📡 Réseau & Communication
- ✅ **Serveur WebSocket** local sur port 9876
  - Communication bidirectionnelle en temps réel
  - Rate limiting (100 msg/60s par client)
  - Validation des messages entrants
  - Heartbeat automatique pour connexions mortes
  - Limite de connexions simultanées (100 max)
  
- ✅ **Service découverte UDP** sur port 9877
  - Broadcast automatique pour détection par réseau local
  - Réponse avec infos serveur (IP, ports, version)

#### 🔒 Sécurité
- ✅ **WebSocket sécurisé** (localhost seulement en prod)
- ✅ **Payload limité** à 100KB par message
- ✅ **Validation structurelle** des messages
- ✅ **Gestion des erreurs robuste** partout
- ✅ **Timeouts réseau** (5s fetch, 10s WebSocket)

#### 📊 Logging & Monitoring
- ✅ **Logging persistent** avec electron-log
- ✅ **Logs rotatifs** (5MB max par fichier)
- ✅ **Niveaux configurables** (debug, info, warn, error)
- ✅ **Format structuré** avec timestamps

#### ⚙️ Configuration
- ✅ **Fichier .env** pour configuration prod
- ✅ **Fallback automatique** si .env manquant
- ✅ **Variation dev/prod** transparente
- ✅ **Variables externalisées** pour tous les paramètres

#### 🔄 Mise à Jour
- ✅ **Auto-updater** via GitHub Releases
- ✅ **Check automatique** au démarrage
- ✅ **Notification utilisateur** des mises à jour
- ✅ **Téléchargement en arrière-plan**

#### 💾 Gestion Mémoire
- ✅ **Map de connexions** avec cleanup automatique
- ✅ **Heartbeat intervals nettoyés** à la fermeture
- ✅ **Pas de fuites mémoire** reconnexions

#### 🎨 UX/UI
- ✅ **Fenêtre sans frame** (custom titlebar ready)
- ✅ **Mode fenêtré/maximisé**
- ✅ **Icône dans la barre des tâches**
- ✅ **Fenêtre offline** en cas de connexion perdue
- ✅ **Dialog "À propos"** avec version
- ✅ **Minimisation en tray** (pas de fermeture réelle)

#### 🖥️ Multi-Plateforme
- ✅ **Windows** (NSIS installer)
- ✅ **macOS** (DMG/App)
- ✅ **Linux** (AppImage + DEB)
- ✅ **Wayland support** sur Linux

### 🐛 Corrections
- ✅ Gestion des erreurs complète
- ✅ Fallback d'icônes si manquantes
- ✅ Récupération sur connexion internet perdue
- ✅ Cleanup des ressources au fermeture

### 📦 Dépendances

| Package | Version | Usage |
|---------|---------|-------|
| electron | 38.7.2 | Framework desktop |
| electron-updater | 6.6.2 | Auto-update |
| electron-log | 5.4.3 | Logging |
| ws | 8.18.3 | WebSocket serveur |
| dotenv | 17.2.3 | Configuration |
| bonjour | 3.5.0 | mDNS (optionnel) |

### 🚀 Installation & Build

```bash
# Installation dépendances
pnpm install

# Mode développement
pnpm start

# Build application
pnpm build

# Publier (GitHub Releases)
pnpm publish

# Générer icônes
pnpm run icons
```

### 📋 Checklist Production

- ✅ Logging en fichier fonctionnel
- ✅ WebSocket avec sécurité robuste
- ✅ Configuration externalisée
- ✅ Gestion d'erreurs complète
- ✅ Icons avec fallback
- ✅ Auto-updater configuré
- ✅ Multi-plateforme (Windows, macOS, Linux)
- ✅ JSDoc comments sur toutes les fonctions
- ✅ README client user-friendly
- ✅ Documentation production

### 📝 Notes

**Premier Lancement** :
- L'application se démarrera automatiquement au boot
- L'icône apparaît dans la barre des tâches
- Les logs sont disponibles dans `%APPDATA%\Wagoo\logs\`

**Mise à Jour** :
- Les mises à jour se font automatiquement
- L'utilisateur est notifié avant mise à jour
- Installation au prochain redémarrage

**Troubleshooting** :
- Si problème de connexion → vérifier réseau
- Si logs ne s'affichent pas → vérifier permissions dossier logs
- Si WebSocket bloqué → vérifier firewall

### 🎓 Documentation

- [README.md](README.md) - Vue d'ensemble projet
- [README-PUBLIC.md](README-PUBLIC.md) - Documentation client
- [PRODUCTION.md](PRODUCTION.md) - Guide production (dev)
- [.env.example](.env.example) - Template configuration

### 👨‍💻 Support Développement

Pour questions techniques : See [PRODUCTION.md](PRODUCTION.md)

---

## Format des Versions Futures

```
## [X.Y.Z] - YYYY-MM-DD

### 🎉 Nouvelle Version
### ✨ Fonctionnalités
### 🐛 Corrections
### 🚀 Améliorations
### ⚠️ Breaking Changes
### 📚 Documentation
```

---

**Wagoo Desktop v1.0.0** — Production Ready ✅
