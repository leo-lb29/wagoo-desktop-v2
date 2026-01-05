# Wagoo Desktop — Guide Agent

Ce document décrit le fonctionnement de l’agent (processus principal Electron) et les points d’intégration (réseau, fenêtres, IPC, mise à jour) à partir des sources du projet.

- Entrée principale : [main.js](main.js)
- Préchargement/IPC (APIs Renderer) : [preload.js](preload.js)
- Ressources (icônes) : [assets/](assets/)

## Architecture

- Processus principal (Electron)
  - Réseau local uniquement (localhost) :
    - Découverte UDP : [`startDiscoveryService`](main.js), [`stopDiscoveryService`](main.js)
    - WebSocket : [`startWebSocketServer`](main.js), [`stopWebSocketServer`](main.js)
    - Diffusion aux clients : [`broadcastToClients`](main.js), statut: [`sendConnectionStatus`](main.js)
  - Fenêtres/UX :
    - Splash : [`createSplash`](main.js)
    - Principale : [`createWindow`](main.js), chargement URL: [`loadMainURL`](main.js)
    - Hors-ligne : [`showOfflineWindow`](main.js)
    - À propos : [`showAboutDialog`](main.js)
    - Notifications : [`showNotification`](main.js)
  - Deep links wagoo:// :
    - Handler : [`handleDeepLink`](main.js)
    - Cible HTTP locale : [`buildTargetFromWagoo`](main.js)
  - Mise à jour (auto-updater) :
    - Initialisation : [`initAutoUpdater`](main.js)
    - IPC: `updater:check`, `updater:download`, `updater:install` (voir [preload.js](preload.js))
  - Sécurité :
    - Filtre d’IP: [`isLocalhost`](main.js)
    - Nettoyage URL: [`sanitizeURL`](main.js)
    - Validation messages WS: [`validateWebSocketMessage`](main.js)
    - CSP via `onHeadersReceived` (session)
    - Navigation bloquée: `will-navigate` (main window)

## Réseau (localhost uniquement)

- Découverte UDP
  - Démarrage: [`startDiscoveryService`](main.js)
  - Arrêt: [`stopDiscoveryService`](main.js)
  - Bind: 127.0.0.1:${[`CONFIG.DISCOVERY_PORT`](main.js)}
  - Requête attendue: `WAGOO_DISCOVERY_REQUEST`
  - Réponse JSON: service, IP, ports, hostname, version, platform

- WebSocket
  - Démarrage: [`startWebSocketServer`](main.js) sur 127.0.0.1:${[`CONFIG.WS_PORT`](main.js)}
  - Connexions client filtrées (localhost) dans [`handleWebSocketConnection`](main.js)
  - Messages gérés dans [`handleWebSocketMessage`](main.js)
    - `qr_scanned` → [`handleQRScanned`](main.js)
    - `ping` → `pong`
    - `notification` → [`showNotification`](main.js)
    - Autres → forward à Renderer via `ws:message`
  - Diffusion: [`broadcastToClients`](main.js)
  - Statut → Renderer: [`sendConnectionStatus`](main.js) (canal `connection:status`)

## Fenêtres et Tray

- Splash: [`createSplash`](main.js)
- Principale: [`createWindow`](main.js)
  - CSP strict via `session.webRequest.onHeadersReceived`
  - Chargement protégé: [`loadMainURL`](main.js) + `HEAD` + timeout `${[`CONFIG.FETCH_TIMEOUT`](main.js)}ms`
  - Navigation externe bloquée via `will-navigate` + [`sanitizeURL`](main.js)
  - Fermer → cacher (app en arrière-plan). Notification d’arrière-plan si supportée.
- Hors-ligne: [`showOfflineWindow`](main.js) (failover si serveur local indisponible)
- À propos: [`showAboutDialog`](main.js)
- Tray: [`createTray`](main.js) (ouvrir, version, à propos, MAJ, quitter)

## Deep links

- Handler: [`handleDeepLink`](main.js)
- Transformation `wagoo://...` → HTTP local via [`buildTargetFromWagoo`](main.js), puis validation avec [`sanitizeURL`](main.js)
- Support multi-instance: verrou via `app.requestSingleInstanceLock()` + `second-instance` (focus fenêtre, traitement du lien)
- Enregistrement protocole: `app.setAsDefaultProtocolClient("wagoo")`
- macOS: événement `open-url`

## IPC exposés (Renderer)

Exposés via [preload.js](preload.js) avec `contextIsolation: true` et API nommées:

- window.electron
  - `minimize()`, `maximize()`, `close()`
- window.updater
  - `checkForUpdates()`, `downloadUpdate()`, `installUpdate()`
  - Listeners: `onChecking`, `onNotAvailable`, `onAvailable`, `onProgress`, `onUpdateDownloaded`, `onError`
- window.electronAPI
  - `getAppInfo()` (version, runtime)
  - Listeners: `onConnectionStatus`, `onWebSocketMessage`
- window.webSocketAPI
  - `send(message)` → IPC `ws:send`
  - `getStatus()` → IPC `ws:getStatus`
- window.discoveryAPI
  - `getInfo()` → IPC `discovery:getInfo`

Événements émis vers Renderer par le main:
- `connection:status` (voir [`sendConnectionStatus`](main.js))
- `ws:message` (fallback messages WS)
- `updater:*` (checking, not-available, available, progress, downloaded, error)

## Sécurité (obligatoire)

- Réseau
  - WebSocket et UDP bindés strictement à localhost (127.0.0.1)
  - Refus des IP non-locales dans [`handleWebSocketConnection`](main.js) et [`startDiscoveryService`](main.js)
- Navigation/URL
  - Validation stricte: [`sanitizeURL`](main.js) (autorise localhost + wagoo://)
  - Navigation bloquée via `will-navigate`
- Contenu / Contexte
  - `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`
  - CSP injecté sur la session de la fenêtre principale
- Messages WS
  - Validation des payloads: [`validateWebSocketMessage`](main.js) (type, taille, forme)
- Notifications / QR
  - Toute URL issue d’un QR passe par [`sanitizeURL`](main.js) et deep link contrôlé
- Auto-updater
  - Désactivé en dev, flux contrôlé via IPC (aucun téléchargement auto)

## Cycle de vie de l’application

- Démarrage: `app.whenReady()` → `createTray()` → `createWindow()` → services réseau (`startWebSocketServer`, `startDiscoveryService`) → `createMenu()` → [`initAutoUpdater`](main.js)
- Fenêtres: `window-all-closed` → l’app reste en arrière-plan (tray)
- Quitter: `before-quit` → [`stopWebSocketServer`](main.js), [`stopDiscoveryService`](main.js)

## Checklist PR

- Réseau
  - WS/UDP: ports tirés de [`CONFIG`](main.js), bind localhost uniquement
  - Arrêt propre: [`stopWebSocketServer`](main.js), [`stopDiscoveryService`](main.js)
- Sécurité
  - Toute URL via [`sanitizeURL`](main.js)
  - Aucune élévation de privilèges dans [preload.js](preload.js)
  - CSP présent et `webSecurity` actif
- UX
  - Tray opérationnel: [`createTray`](main.js)
  - Splash/hors-ligne/principale À jour: [`createSplash`](main.js), [`showOfflineWindow`](main.js), [`createWindow`](main.js)
- MAJ
  - Flux `updater:*` testé (check, download, install)
- Deep link
  - `wagoo://` transformé via [`buildTargetFromWagoo`](main.js), accepté par [`sanitizeURL`](main.js)
- Exports testables
  - [`CONFIG`](main.js), [`isLocalhost`](main.js), [`sanitizeURL`](main.js), [`validateWebSocketMessage`](main.js)

## Références rapides

- Fichier principal: [main.js](main.js)
- Préchargement/IPC: [preload.js](preload.js)
- Icônes/app: [assets/](assets/)
- Scripts/packaging: [package.json](package.json)