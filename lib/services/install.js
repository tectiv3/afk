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
        this.USER_CFG_DIR = path.join(this.HOME, '.afk')
        this.USER_BIN = path.join(this.USER_CFG_DIR, 'bin')
    }

    /**
     * Install AFK hooks at user or project level
     * @param {string} scope - 'user', 'project', or 'local'
     * @param {string} projectRoot - Required for project/local scope
     */
    install(scope, projectRoot) {
        if (scope === 'user') {
            this.utils.ensureDir(this.USER_BIN)
            const dest = path.join(this.USER_BIN, 'afk')
            fs.copyFileSync(process.argv[1], dest)
            this.utils.ensureExecutable(dest)
            // Copy lib/ directory so relative requires from bin/afk resolve correctly
            const sourceLib = path.resolve(path.dirname(process.argv[1]), '..', 'lib')
            const destLib = path.join(this.USER_CFG_DIR, 'lib')
            this.copyDirRecursive(sourceLib, destLib)
            const settingsPath = this.writeSettings('user')
            console.log(`[afk] Installed hooks at user level: ${settingsPath}`)
            console.log(`[afk] Next: in Claude Code, run /hooks to approve.`)
            console.log(`[afk] Tip: switch modes with afk on (remote) or afk off (local).`)
        } else {
            if (!projectRoot) {
                this.logger.eprint('--project-root is required for project/local install')
                process.exit(2)
            }
            const pr = path.resolve(projectRoot)
            const settingsPath = this.writeSettings(scope, pr)
            console.log(`[afk] Installed hooks at ${scope} level: ${settingsPath}`)
            console.log(`[afk] Next: inside this project, run /hooks to approve.`)
            console.log(`[afk] Tip: switch modes with afk on (remote) or afk off (local).`)
        }
    }

    /**
     * Show uninstallation instructions
     * @param {string} scope - 'user', 'project', or 'local'
     */
    uninstall(scope) {
        if (scope === 'user') {
            console.log(
                `To uninstall, remove hook entries from ~/.claude/settings.json hooks section and delete ~/.afk.`
            )
        } else {
            console.log(
                `To uninstall, remove hook entries from your project's .claude/settings(.local).json and delete ./.claude/hooks/afk`
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
        let settingsPath, hookCmdBase, scopeDir
        if (scope === 'user') {
            settingsPath = path.join(this.HOME, '.claude', 'settings.json')
            hookCmdBase = this.utils.toPosix(path.join(this.USER_BIN, 'afk'))
            scopeDir = path.join(this.HOME, '.claude')
        } else {
            if (!projectRoot) throw new Error('project_root required')
            scopeDir = path.join(projectRoot, '.claude')
            settingsPath = path.join(
                scopeDir,
                scope === 'local' ? 'settings.local.json' : 'settings.json'
            )
            const dest = path.join(scopeDir, 'hooks', 'afk')
            this.utils.ensureDir(path.dirname(dest))
            fs.copyFileSync(process.argv[1], dest)
            this.utils.ensureExecutable(dest)
            // Copy lib/ so relative requires from hooks/afk resolve correctly
            const sourceLib = path.resolve(path.dirname(process.argv[1]), '..', 'lib')
            const destLib = path.join(scopeDir, 'lib')
            this.copyDirRecursive(sourceLib, destLib)
            hookCmdBase = this.utils.toPosix(dest)
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

    /**
     * Recursively copy a directory
     * @param {string} src - Source directory
     * @param {string} dest - Destination directory
     */
    copyDirRecursive(src, dest) {
        if (!fs.existsSync(src)) return
        fs.mkdirSync(dest, { recursive: true })
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            const srcPath = path.join(src, entry.name)
            const destPath = path.join(dest, entry.name)
            if (entry.isDirectory()) {
                this.copyDirRecursive(srcPath, destPath)
            } else {
                fs.copyFileSync(srcPath, destPath)
            }
        }
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
