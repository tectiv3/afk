/**
 * Configuration Management Module
 *
 * Provides configuration loading, saving, and management for the afk application.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { Utils } = require('./utils')

// Constants
const HOME = os.homedir()
const USER_CFG_DIR = path.join(HOME, '.config', 'afk')
const USER_CFG = path.join(USER_CFG_DIR, 'config.json')
const STATE_FILE = path.join(USER_CFG_DIR, 'mode') // "remote" | "local" | "readonly"
const DEFAULT_MODE = 'local'
const DEFAULT_TIMEOUT = 3600 // 1 hour (in seconds)
const DEFAULT_TIMEOUT_ACTION = 'deny' // 'deny', 'allow', or 'wait'

/**
 * Configuration Manager Class
 * Handles loading, saving and managing application configuration
 */
class ConfigManager {
    constructor(configPath = USER_CFG, configDir = USER_CFG_DIR) {
        this.configPath = configPath
        this.configDir = configDir
        this._cachedConfig = null
    }

    /**
     * Load JSON file with default fallback
     * @param {string} filePath - Path to JSON file
     * @param {*} defaultValue - Default value if file doesn't exist or is invalid
     * @returns {*} Parsed JSON or default value
     */
    loadJson(filePath, defaultValue = {}) {
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf8'))
            }
        } catch (e) {
            console.error(`[afk] Failed to read ${filePath}: ${e.message}`)
        }
        return defaultValue
    }

    /**
     * Save object as JSON file atomically
     * @param {string} filePath - Path to save file
     * @param {*} obj - Object to save as JSON
     */
    saveJson(filePath, obj) {
        Utils.ensureDir(path.dirname(filePath))
        const tmp = filePath + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
        fs.renameSync(tmp, filePath)
    }

    /**
     * Load and cache configuration with environment variable fallbacks
     * @returns {Object} Configuration object
     */
    cfg() {
        if (this._cachedConfig) {
            return this._cachedConfig
        }

        const config = this.loadJson(this.configPath, {})

        // Apply defaults and environment variable fallbacks
        config.telegram_bot_token =
            config.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || ''
        config.telegram_chat_id = config.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || ''
        config.timeout_seconds = config.timeout_seconds || DEFAULT_TIMEOUT
        config.timeout_action = config.timeout_action || DEFAULT_TIMEOUT_ACTION

        this._cachedConfig = config
        return config
    }

    /**
     * Write default configuration if it doesn't exist
     */
    writeDefaultConfig() {
        if (!fs.existsSync(this.configPath)) {
            this.saveJson(this.configPath, this.cfg())
            console.log(`Wrote default config at ${this.configPath}`)
        }
    }

    /**
     * Clear cached configuration (useful for testing or when config changes)
     */
    clearCache() {
        this._cachedConfig = null
    }

    /**
     * Get configuration directory path
     * @returns {string} Configuration directory path
     */
    getConfigDir() {
        return this.configDir
    }

    /**
     * Get configuration file path
     * @returns {string} Configuration file path
     */
    getConfigPath() {
        return this.configPath
    }

    /**
     * Read current AFK mode
     * @returns {string} Current mode ('remote', 'local', or 'readonly')
     */
    readMode() {
        const stateFile = path.join(this.configDir, 'mode')
        try {
            if (fs.existsSync(stateFile)) {
                const mode = fs.readFileSync(stateFile, 'utf8').trim()
                return mode === 'remote' || mode === 'local' || mode === 'readonly'
                    ? mode
                    : DEFAULT_MODE
            }
        } catch (e) {
            // File doesn't exist or can't be read
        }
        return DEFAULT_MODE
    }

    /**
     * Write AFK mode
     * @param {string} mode - Mode to set ('remote', 'local', or 'readonly')
     */
    writeMode(mode) {
        if (!['remote', 'local', 'readonly'].includes(mode)) {
            throw new Error(`Invalid mode: ${mode}. Must be 'remote', 'local', or 'readonly'.`)
        }

        const stateFile = path.join(this.configDir, 'mode')
        try {
            // Ensure config directory exists
            if (!fs.existsSync(this.configDir)) {
                fs.mkdirSync(this.configDir, { recursive: true })
            }
            fs.writeFileSync(stateFile, mode)
        } catch (e) {
            throw new Error(`Failed to write mode: ${e.message}`)
        }
    }

    /**
     * Handle mode command (on/off/toggle/status)
     * @param {string} subcommand - Mode subcommand
     * @param {Function} logger - Logger function for debug output
     */
    modeCommand(subcommand, logger = null) {
        if (logger) {
            logger('MODE_COMMAND', 'Processing mode command', {
                subcommand,
                currentMode: this.readMode(),
            })
        }

        if (['on', 'remote'].includes(subcommand)) {
            const oldMode = this.readMode()
            this.writeMode('remote')
            if (logger) {
                logger('MODE_CHANGE', 'Mode changed', {
                    oldMode,
                    newMode: 'remote',
                    trigger: 'mode_command',
                })
            }
            return 'remote'
        } else if (['off', 'local'].includes(subcommand)) {
            const oldMode = this.readMode()
            this.writeMode('local')
            if (logger) {
                logger('MODE_CHANGE', 'Mode changed', {
                    oldMode,
                    newMode: 'local',
                    trigger: 'mode_command',
                })
            }
            return 'local'
        } else if (subcommand === 'readonly') {
            const oldMode = this.readMode()
            this.writeMode('readonly')
            if (logger) {
                logger('MODE_CHANGE', 'Mode changed', {
                    oldMode,
                    newMode: 'readonly',
                    trigger: 'mode_command',
                })
            }
            return 'readonly'
        } else if (subcommand === 'toggle') {
            const currentMode = this.readMode()
            // Toggle between local and remote only (readonly is separate)
            let newMode
            if (currentMode === 'local') {
                newMode = 'remote'
            } else {
                // From remote or readonly, go to local
                newMode = 'local'
            }
            this.writeMode(newMode)
            if (logger) {
                logger('MODE_CHANGE', 'Mode toggled', {
                    oldMode: currentMode,
                    newMode: newMode,
                    trigger: 'mode_toggle',
                })
            }
            return newMode
        } else {
            // Status or unknown command - return current mode
            return this.readMode()
        }
    }
}

module.exports = {
    ConfigManager,
    USER_CFG_DIR,
    USER_CFG,
    STATE_FILE,
    DEFAULT_MODE,
    DEFAULT_TIMEOUT,
    DEFAULT_TIMEOUT_ACTION,
}
