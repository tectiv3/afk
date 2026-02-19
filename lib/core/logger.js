/**
 * Logging Module
 *
 * Provides structured logging capabilities for the afk application.
 * Maintains backward compatibility with existing logging patterns.
 */

const fs = require('fs')
const path = require('path')
const { Utils } = require('./utils')

/**
 * Logger Class
 * Provides structured debug logging with file and console output
 */
class Logger {
    constructor(configDir, debugLogFile, stateFile) {
        this.configDir = configDir
        this.debugLogFile = debugLogFile || path.join(configDir, 'debug.log')
        this.stateFile = stateFile || path.join(configDir, 'mode')
        this._debugMode = null // Cache debug mode check
    }

    /**
     * Check if debug mode is enabled
     * @returns {boolean} True if debug mode is enabled
     */
    isDebugEnabled() {
        if (this._debugMode !== null) {
            return this._debugMode
        }

        // Check persistent debug setting
        const debugFile = path.join(this.configDir, '.debug')
        if (fs.existsSync(debugFile)) {
            this._debugMode = true
            return true
        }

        // Check environment variable
        if (process.env.AFK_DEBUG === '1' || process.env.CC_REMOTE_DEBUG === '1') {
            if (process.env.CC_REMOTE_DEBUG === '1') {
                this.eprint(
                    '[afk] Warning: CC_REMOTE_DEBUG is deprecated, use AFK_DEBUG instead'
                )
            }
            this._debugMode = true
            return true
        }

        // Check command line flag
        if (process.argv.includes('--debug')) {
            this._debugMode = true
            return true
        }

        this._debugMode = false
        return false
    }

    /**
     * Output to stderr (error print)
     * @param {...any} args - Arguments to print
     */
    eprint(...args) {
        console.error(...args)
    }

    /**
     * Structured debug logging
     * @param {string} category - Category of the log entry
     * @param {string} message - Log message
     * @param {*} data - Optional data to include (will be JSON stringified)
     */
    debugLog(category, message, data = null) {
        if (!this.isDebugEnabled()) return

        const timestamp = new Date().toISOString()
        const logEntry = {
            timestamp,
            category,
            message,
            data,
            pid: process.pid,
            mode: this._readMode(),
            session: process.env.CLAUDE_SESSION_ID || 'unknown',
        }

        // Log to stderr for immediate visibility
        const logLine = `[DEBUG ${timestamp}] [${category}] ${message}`
        if (data) {
            this.eprint(logLine, JSON.stringify(data, null, 2))
        } else {
            this.eprint(logLine)
        }

        // Also append to debug log file
        try {
            Utils.ensureDir(this.configDir)
            fs.appendFileSync(this.debugLogFile, JSON.stringify(logEntry) + '\n')
        } catch (e) {
            // Silent fail - don't break the app if logging fails
        }
    }

    /**
     * Clear the debug mode cache (useful for testing)
     */
    clearDebugCache() {
        this._debugMode = null
    }

    /**
     * Set debug log file path (useful for testing)
     * @param {string} filePath - New debug log file path
     */
    setDebugLogFile(filePath) {
        this.debugLogFile = filePath
    }

    /**
     * Read current mode from state file (private helper)
     * @private
     * @returns {string} Current mode ('remote' or 'local')
     */
    _readMode() {
        if (fs.existsSync(this.stateFile)) {
            const v = fs.readFileSync(this.stateFile, 'utf8').trim()
            return v === 'remote' || v === 'local' || v === 'readonly' ? v : 'local'
        }
        return 'local'
    }
}

module.exports = { Logger }
