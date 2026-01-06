/**
 * Module de logging centralisé pour Wagoo Desktop
 * Sauvegarde les logs en fichier pour le debug en production
 */

const log = require("electron-log");
const path = require("path");

/**
 * Configure electron-log avec les paramètres de production
 * @param {string} logsDir - Répertoire de destination des logs
 */
function initLogger(logsDir) {
  // Configuration du format
  log.transports.file.format = "{h}:{i}:{s} {text}";
  log.transports.file.maxSize = process.env.LOG_SIZE_BYTES || 5242880; // 5MB
  
  // Configuration du chemin des logs
  log.transports.file.file = path.join(logsDir, "wagoo-desktop.log");
  
  // Niveau de log
  log.transports.console.level = process.env.LOG_LEVEL || "info";
  log.transports.file.level = process.env.LOG_LEVEL || "info";

  // Garder les anciens logs
  log.transports.file.maxSize = parseInt(process.env.LOG_SIZE_BYTES) || 5242880;

  return log;
}

/**
 * Crée un logger spécifique pour un module
 * @param {string} moduleName - Nom du module pour identifier dans les logs
 * @returns {object} Logger formaté
 */
function createModuleLogger(moduleName) {
  return {
    debug: (msg, data) => log.debug(`[${moduleName}] ${msg}`),
    info: (msg, data) => log.info(`[${moduleName}] ${msg}`),
    warn: (msg, data) => log.warn(`[${moduleName}] ${msg}`),
    error: (msg, data) => log.error(`[${moduleName}] ${msg}`),
  };
}

module.exports = {
  initLogger,
  createModuleLogger,
  log,
};
