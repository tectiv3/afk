/**
 * CLI module for afk binary
 * Handles command line display formatting
 */

/**
 * CLI Service class for command line interface operations
 */
class CLIService {
    /**
     * Initialize CLI service
     * @param {ConfigManager} configManager - Configuration manager instance
     * @param {Logger} logger - Logger instance
     * @param {Utils} utils - Utils instance
     */
    constructor(configManager, logger, utils) {
        this.configManager = configManager
        this.logger = logger
        this.utils = utils
    }

    /**
     * Show help text for the CLI
     */
    showHelp() {
        console.log(
            `afk — Away From Keyboard + Telegram approvals

Smart Toggle:
  afk                    Smart toggle - installs if needed, otherwise toggles mode

Direct Commands:
  afk on                 Enable AFK mode (remote approvals)
  afk off                Disable AFK mode (local mode)
  afk toggle             Toggle between local and remote modes
  afk status             Show current AFK mode

Full Commands:
  install [--scope user|project|local] [--project-root PATH]
      Install Claude Code hooks at the chosen scope (prompts if omitted).
  setup
      Interactive wizard to link your Telegram bot and chat.
  uninstall --scope user|project|local [--project-root PATH]
      Print removal instructions for that scope.
  mode [on|off|toggle|local|remote|status]
      Switch between LOCAL (no remote approvals) and REMOTE (Telegram approvals).
  debug [on|off|status]
      Enable/disable persistent debug logging to ~/.config/afk/debug.log
  telegram test
      Send a test message to verify Telegram connection.
  hook permissionrequest|stop|sessionstart
      Internal entrypoints used by Claude Code hooks.

Examples:
  afk                    # Smart toggle: install or toggle mode
  afk on                 # Enable remote mode
  afk off                # Enable local mode
  afk install            # Install hooks
  afk telegram test      # Test Telegram connection`
        )
    }

    /**
     * Show mode explanation based on current mode
     * @param {string} mode - Current mode ('remote', 'local', or 'readonly')
     */
    showModeExplanation(mode) {
        if (mode === 'remote') {
            console.log('REMOTE — All permissioned tool calls require Telegram approval.')
        } else if (mode === 'readonly') {
            console.log(
                'READ-ONLY — Get notifications for tool calls and sessions without blocking.'
            )
        } else {
            console.log("LOCAL — Tools run with Claude's normal permission prompts.")
        }
    }
}

module.exports = {
    CLIService,
}
