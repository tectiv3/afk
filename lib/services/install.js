#!/usr/bin/env node
/**
 * Install Service Module
 * Handles installation, uninstallation, and settings configuration
 * for Claude Code hook integration.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

/**
 * InstallService class for managing AFK installation and configuration
 */
class InstallService {
    constructor(configManager, permissionsService, logger, utils) {
        this.configManager = configManager
        this.permissionsService = permissionsService
        this.logger = logger
        this.utils = utils

        // Constants
        this.HOME = os.homedir()
    }

    /**
     * Install AFK hooks at user or project level
     * @param {string} scope - 'user', 'project', or 'local'
     * @param {string} projectRoot - Required for project/local scope
     */
    install(scope, projectRoot) {
        if (scope === 'user') {
            const settingsPath = this.writeSettings('user')
            console.log(`[afk] Installed hooks at user level: ${settingsPath}`)
            console.log(`[afk] Hooks point to: ${path.resolve(process.argv[1])}`)
            console.log(`[afk] Next: in Claude Code, run /hooks to approve.`)
        } else {
            if (!projectRoot) {
                this.logger.eprint('--project-root is required for project/local install')
                process.exit(2)
            }
            const pr = path.resolve(projectRoot)
            const settingsPath = this.writeSettings(scope, pr)
            console.log(`[afk] Installed hooks at ${scope} level: ${settingsPath}`)
            console.log(`[afk] Hooks point to: ${path.resolve(process.argv[1])}`)
            console.log(`[afk] Next: inside this project, run /hooks to approve.`)
        }
    }

    /**
     * Show uninstallation instructions
     * @param {string} scope - 'user', 'project', or 'local'
     */
    uninstall(scope) {
        if (scope === 'user') {
            console.log(
                `To uninstall, remove hook entries from ~/.claude/settings.json hooks section and delete ~/.config/afk.`
            )
        } else {
            console.log(
                `To uninstall, remove hook entries from your project's .claude/settings(.local).json.`
            )
        }
    }

    /**
     * Write Claude Code settings with AFK hooks
     * @param {string} scope - 'user', 'project', or 'local'
     * @param {string} projectRoot - Project root directory (required for project/local)
     * @returns {string} Settings file path
     */
    writeSettings(scope, projectRoot) {
        let settingsPath
        const hookCmdBase = this.utils.toPosix(path.resolve(process.argv[1]))

        if (scope === 'user') {
            settingsPath = path.join(this.HOME, '.claude', 'settings.json')
        } else {
            if (!projectRoot) throw new Error('project_root required')
            const scopeDir = path.join(projectRoot, '.claude')
            settingsPath = path.join(
                scopeDir,
                scope === 'local' ? 'settings.local.json' : 'settings.json'
            )
        }

        const permissionCmd = `${hookCmdBase} hook permissionrequest`
        const stopCmd = `${hookCmdBase} hook stop`
        const sessionStartCmd = `${hookCmdBase} hook sessionstart`
        let settings = this.configManager.loadJson(settingsPath, {})
        settings = this.permissionsService.mergeHooks(
            settings,
            [{ type: 'command', command: permissionCmd, timeout: 21600 }],
            'PermissionRequest',
            null
        )
        // Notification hook removed - redundant with PermissionRequest
        settings = this.permissionsService.mergeHooks(
            settings,
            [{ type: 'command', command: stopCmd, timeout: 21600 }],
            'Stop',
            null
        )
        settings = this.permissionsService.mergeHooks(
            settings,
            [{ type: 'command', command: sessionStartCmd, timeout: 21600 }],
            'SessionStart',
            null
        )
        this.configManager.saveJson(settingsPath, settings)
        return settingsPath
    }

}


/**
 * Backward compatibility functions - these maintain the exact same interface
 * as the original functions in bin/afk
 */

/**
 * Install AFK (backward compatibility)
 * @param {string} scope - Installation scope
 * @param {string} projectRoot - Project root directory
 */
function install(scope, projectRoot) {
    throw new Error(
        'install function requires service dependencies - use InstallService instead'
    )
}

/**
 * Uninstall AFK (backward compatibility)
 * @param {string} scope - Installation scope
 */
function uninstall(scope) {
    throw new Error(
        'uninstall function requires service dependencies - use InstallService instead'
    )
}

/**
 * Write settings (backward compatibility)
 * @param {string} scope - Installation scope
 * @param {string} projectRoot - Project root directory
 */
function writeSettings(scope, projectRoot) {
    throw new Error(
        'writeSettings function requires service dependencies - use InstallService instead'
    )
}

module.exports = {
    InstallService,
    // Functional exports for backward compatibility
    install,
    uninstall,
    writeSettings,
}
