# Guide de Production - Wagoo Desktop

## Améliorations Apportées pour la Production

### 1. ✅ Gestion des Erreurs Robuste
- **Try/catch systématique** partout (services, fenêtres, notifications, IPC)
- **Gestion de crashs** du contenu webview
- **Fallback d'icônes** si ressources manquantes
- **Timeouts sur fetch** et connexions WebSocket

### 2. ✅ Logging en Fichier
- **electron-log** intégré pour logs persistants
- Les logs sont sauvegardés dans : `%APPDATA%/Wagoo/logs/wagoo-desktop.log`
- **Rotation automatique** des logs (5MB max par fichier)
- **Niveaux de log** configurables (debug, info, warn, error)
- Format: `[HH:MM:SS] [MODULE] Message`

### 3. ✅ Sécurité WebSocket
- **Validation des messages** : type + structure
- **Rate limiting** par client (100 msg/60s par défaut)
- **Limite de connexions** simultanées (100 max par défaut)
- **Payload maximal** : 100KB par message
- **Authentification réseau** via localhost seulement en prod
- **Heartbeat** pour détecter les connexions mortes

### 4. ✅ Configuration Externalisée
- **Fichier .env** pour tous les paramètres
- **Variation dev/prod** automatique
- Variables configurables :
  - Ports, URLs, timeouts
  - Limites de sécurité
  - Niveaux de logging

Voir `.env` pour la configuration complète.

### 5. ✅ Gestion Mémoire
- **Map au lieu de Set** pour les connexions WebSocket
- **Cleanup automatique** des connexions fermées
- **Heartbeat intervals nettoyés** à la fermeture
- **Limite maximale** de connexions simultanées
- Pas de fuites mémoire sur les reconnexions

### 6. ✅ Icônes Fallback
- **Recherche d'icônes multi-chemins** avec fallback
- Si icône manquante → charge depuis chemin alternatif
- Ne plante jamais sur icône manquante
- Logs pour déboguer les icônes manquantes

### 7. ✅ Documentation JSDoc
- **Chaque fonction** documentée avec JSDoc
- **Types de paramètres** et retours spécifiés
- **Descriptions claires** du comportement
- IDE autocomplete supporté

---

## Configuration Production

### Fichier .env

Copier `.env.example` en `.env` et configurer :

```env
# Sécurité
WS_LOCALHOST_ONLY=true          # true = localhost seulement, false = 0.0.0.0
WS_MAX_CONNECTIONS=100          # Limite de connexions simultanées
WS_RATE_LIMIT_WINDOW_MS=60000   # Fenêtre rate limiting (60s)
WS_RATE_LIMIT_MAX_MESSAGES=100  # Max messages par fenêtre

# Timeouts
FETCH_TIMEOUT=5000              # Timeout fetch en ms
WS_HEARTBEAT_INTERVAL=30000     # Heartbeat interval en ms
WS_CONNECTION_TIMEOUT=10000     # Timeout connexion WebSocket

# Logging
LOG_LEVEL=info                  # debug|info|warn|error
LOG_SIZE_BYTES=5242880          # Max size log avant rotation (5MB)
LOG_MAX_BACKUPS=3               # Nombre de logs gardés
```

### Déploiement

1. **Générer les icônes** :
   ```bash
   npm run icons
   ```

2. **Builder l'app** :
   ```bash
   npm run build
   ```

3. **Publier** (GitHub releases) :
   ```bash
   npm run publish
   ```

---

## Monitoring en Production

### Logs
Les logs sont localisés dans :
- **Windows** : `%APPDATA%\Wagoo\logs\wagoo-desktop.log`
- **macOS** : `~/Library/Logs/Wagoo/wagoo-desktop.log`
- **Linux** : `~/.config/Wagoo/logs/wagoo-desktop.log`

### Vérifier la Santé
```bash
# Vérifier qu'aucun processus Wagoo ne traîne
Get-Process wagoo -ErrorAction SilentlyContinue
```

### Erreurs Courantes

| Erreur | Cause | Solution |
|--------|-------|----------|
| `Impossible démarrer WebSocket` | Port occupé | Vérifier `WS_PORT` en .env |
| `Site non joignable` | Réseau offline | Vérifier configuration URLs |
| `Icône introuvable` | Ressources manquantes | Voir logs pour chemin attendu |
| `Rate limit dépassé` | Client envoie trop de messages | Augmenter `WS_RATE_LIMIT_MAX_MESSAGES` |

---

## Checklist Avant Production

- ✅ .env configuré correctement
- ✅ Icons générées (`npm run icons`)
- ✅ App testée en mode packagée
- ✅ Auto-update configuré (GitHub releases)
- ✅ Logs générés et consultables
- ✅ Pas d'erreurs console
- ✅ WebSocket fonctionnelle
- ✅ Deeplinks wagoo:// testés
- ✅ Notifications système actives
- ✅ Service découverte UDP actif

---

## Support

Pour les logs détaillés, augmentez `LOG_LEVEL=debug` dans `.env` et redémarrez l'application.
