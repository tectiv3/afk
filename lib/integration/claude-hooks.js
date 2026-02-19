/**
 * Claude Integration Hooks
 *
 * This module contains the core hook handlers that integrate with Claude Code:
 * - PermissionRequest: Main permission approval hook handler
 * - Stop: Stop hook handler for task completion
 * - SessionStart: Session start hook handler for initial instructions
 */

const fs = require('fs')
const path = require('path')

/**
 * Claude Hooks Service Class
 * Handles all Claude Code integration points and hook processing
 */
class ClaudeHooksService {
    constructor(
        configManager,
        telegramService,
        permissionsService,
        sessionsService,
        queueService,
        logger,
        utils
    ) {
        this.configManager = configManager
        this.telegramService = telegramService
        this.permissionsService = permissionsService
        this.sessionsService = sessionsService
        this.queueService = queueService
        this.logger = logger
        this.utils = utils
    }

    /**
     * Format tool information for display in Telegram messages
     * @param {string} toolName - Name of the tool
     * @param {Object} toolInput - Tool input parameters
     * @returns {string} Formatted tool display string
     */
    formatToolDisplay(toolName, toolInput) {
        const summary = this.summarizeTool(toolName, toolInput)
        const toolCmd = toolInput.command || ''
        const shortCmd = toolCmd.length > 50 ? toolCmd.substring(0, 50) + '...' : toolCmd
        return `${toolName}${shortCmd ? `: ${shortCmd}` : ''}`
    }

    /**
     * Process tool approval from Telegram callback
     * @param {Object} update - Telegram update object
     * @param {string} approvalId - Approval ID
     * @param {string} sessionId - Session ID
     * @returns {Object} Decision object for Claude Code
     */
    async processToolApproval(update, approvalId, sessionId) {
        const callbackData = update.callback_query.data || ''
        const parts = callbackData.split(':')
        const decision = parts[0] // 'approve', 'deny', 'allow_all', 'ask_ui'
        const args = parts.slice(2) // Everything after action:approvalId

        this.logger.debugLog('CALLBACK_PARSE', 'Processing tool approval', {
            decision,
            args,
            sessionId: sessionId?.substring(0, 8) + '...',
        })

        // Load metadata for the approval
        const metaFile = path.join(this.getApprovalDir(), `${approvalId}.meta`)
        let metadata = {}
        try {
            if (fs.existsSync(metaFile)) {
                metadata = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
                fs.unlinkSync(metaFile) // Clean up
            }
        } catch (e) {
            this.logger.eprint(`[approval] Failed to read metadata: ${e.message}`)
        }

        const {
            patterns = [],
            toolName = '',
            toolInput = {},
            cwd = '',
            permissionSuggestions = [],
        } = metadata
        const label = this.escapeHtml(this.projectLabel(cwd))

        // Helper: update the approval message in Telegram (non-fatal if it fails)
        const safeDisplay = this.escapeHtml(this.formatToolDisplay(toolName, toolInput))
        const chatId = update.callback_query.message.chat.id
        const messageId = update.callback_query.message.message_id
        const token = this.configManager.cfg().telegram_bot_token

        const ackAndEdit = async statusText => {
            try {
                await this.telegramService.tgApiWithToken(token, 'answerCallbackQuery', {
                    callback_query_id: update.callback_query.id,
                })
                await this.telegramService.tgApiWithToken(token, 'editMessageText', {
                    chat_id: chatId,
                    message_id: messageId,
                    text: statusText,
                    parse_mode: 'HTML',
                })
            } catch (e) {
                this.logger.eprint(`[approval] Failed to update message: ${e.message}`)
            }
        }

        if (decision === 'approve') {
            await ackAndEdit(`[${label}] ✅ <b>Approved</b> — ${safeDisplay}`)

            this.sessionsService.appendHistory({
                type: 'approval',
                session_id: sessionId,
                decision: 'approve',
                tool_name: toolName,
            })

            return {
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: { behavior: 'allow' },
                },
            }
        } else if (decision === 'deny') {
            await ackAndEdit(`[${label}] ❌ <b>Denied</b> — ${safeDisplay}`)

            this.sessionsService.appendHistory({
                type: 'approval',
                session_id: sessionId,
                decision: 'deny',
                tool_name: toolName,
            })

            return {
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: { behavior: 'deny', message: 'Denied via Telegram' },
                },
            }
        } else if (decision === 'allow_all') {
            await ackAndEdit(`[${label}] ✅ <b>Allowed All</b> — ${safeDisplay}`)

            this.sessionsService.appendHistory({
                type: 'approval',
                session_id: sessionId,
                decision: 'allow_all',
                tool_name: toolName,
                permissionSuggestions,
            })

            // Use CC's native updatedPermissions instead of manually writing settings.
            // permissionSuggestions comes from the PermissionRequest input and contains
            // the "always allow" options (e.g. { type: "toolAlwaysAllow", tool: "Bash" }).
            // CC handles scoping (session-scoped for edits, persistent for commands).
            return {
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: {
                        behavior: 'allow',
                        updatedPermissions: permissionSuggestions,
                    },
                },
            }
        } else if (decision === 'ask_ui') {
            await ackAndEdit(`[${label}] 🔧 <b>Delegating to Claude UI</b> — ${safeDisplay}`)

            this.sessionsService.appendHistory({
                type: 'approval',
                session_id: sessionId,
                decision: 'ask_ui',
                tool_name: toolName,
            })

            // null = no opinion, fall through to normal Claude UI permission prompt
            return null
        }

        // Unknown decision — fall through to normal prompt
        return null
    }

    /**
     * Main PermissionRequest hook handler
     * @param {Object} data - Hook input data from Claude Code
     */
    async handlePermissionRequest(data) {
        const {
            tool_name: toolName,
            tool_input: toolInput = {},
            session_id: sessionId,
            cwd,
            permission_suggestions: permissionSuggestions,
        } = data

        this.logger.debugLog('HOOK_PERMISSION', 'PermissionRequest hook triggered', {
            toolName,
            toolInput,
            sessionId,
            cwd,
            transcript_path: data.transcript_path,
        })

        // Check effective mode using hierarchy (session > project > global)
        const mode = this.getEffectiveMode(sessionId, cwd)
        if (mode === 'readonly') {
            // Send non-blocking notification, then fall through to Claude UI
            const label = this.escapeHtml(this.projectLabel(cwd))
            const summary = this.escapeHtml(this.summarizeTool(toolName, toolInput))
            const text = `[${label}] 🔧 <b>${this.escapeHtml(toolName)}</b>\n${summary}`
            await this.telegramService.sendMessage(text, null, 'HTML').catch(() => {})
            return
        }
        if (mode !== 'remote') {
            this.logger.debugLog('HOOK_PERMISSION', `${mode} mode - skipping intervention`, {
                mode,
                decision: 'skip',
                reason: `${mode} mode active`,
            })
            // Empty stdout = no opinion, fall through to normal Claude UI prompt
            return
        }

        // AskUserQuestion gets a different flow — show question with option buttons
        if (toolName === 'AskUserQuestion') {
            const result = await this.handleQuestion(data)
            if (result) {
                process.stdout.write(JSON.stringify(result))
            }
            return
        }

        // Generate Telegram approval request
        const approvalId = this.utils.cryptoRandomId()
        const approvalDir = this.getApprovalDir()
        this.utils.ensureDir(approvalDir)

        // Prepare approval request
        const patterns = this.permissionsService.generatePermissionPattern(toolName, toolInput)
        const summary = this.summarizeTool(toolName, toolInput)
        const label = this.projectLabel(cwd)

        // Store metadata for the approval
        const metaFile = path.join(approvalDir, `${approvalId}.meta`)
        fs.writeFileSync(
            metaFile,
            JSON.stringify({
                patterns,
                toolName,
                toolInput,
                cwd,
                sessionId,
                permissionSuggestions,
            })
        )

        // Send Telegram approval request
        await this.sendApprovalRequest(
            approvalId,
            toolName,
            toolInput,
            summary,
            patterns,
            label,
            sessionId,
            cwd,
            data.transcript_path
        )

        // Wait for approval response and write decision to stdout
        const result = await this.waitForApproval(approvalId, sessionId, toolName, toolInput)
        if (result) {
            process.stdout.write(JSON.stringify(result))
        }
        // Empty stdout = no opinion, fall through to normal Claude UI prompt
    }

    /**
     * Handle AskUserQuestion — show question with option buttons, collect answers
     * @param {Object} data - Hook input data from Claude Code
     * @returns {Object|null} Hook response with updatedInput.answers, or null to fall through
     */
    async handleQuestion(data) {
        const { tool_input: toolInput = {}, session_id: sessionId, cwd } = data
        const questions = toolInput.questions || []
        const label = this.escapeHtml(this.projectLabel(cwd))
        const approvalId = this.utils.cryptoRandomId()

        if (questions.length === 0) {
            return null // fall through to Claude UI
        }

        const answers = {}

        for (let qi = 0; qi < questions.length; qi++) {
            const q = questions[qi]
            const questionText = q.question || ''
            const options = q.options || []
            const isMultiSelect = q.multiSelect === true

            // Format message
            const parts = [`[${label}] 📋 <b>Question</b>`]
            if (q.header) parts.push(`<i>${this.escapeHtml(q.header)}</i>`)
            parts.push('')
            parts.push(`<b>${this.escapeHtml(questionText)}</b>`)
            parts.push('')

            for (let i = 0; i < options.length; i++) {
                const opt = options[i]
                const optLabel = this.escapeHtml(opt.label || '')
                const optDesc = opt.description ? ` — ${this.escapeHtml(opt.description)}` : ''
                parts.push(`${i + 1}. <b>${optLabel}</b>${optDesc}`)
            }

            if (isMultiSelect) {
                parts.push('')
                parts.push('<i>Reply with numbers like 1,3 to select multiple</i>')
            }

            const text = parts.join('\n')

            // Build inline keyboard — one button per option (truncate label to 30 chars)
            const optionButtons = options.map((opt, i) => {
                const btnLabel =
                    opt.label.length > 30 ? opt.label.substring(0, 28) + '..' : opt.label
                return {
                    text: `${i + 1}. ${btnLabel}`,
                    callback_data: `qopt:${approvalId}:${i}`,
                }
            })

            // Arrange buttons in rows of 1 (options can be long)
            const keyboard = {
                inline_keyboard: [
                    ...optionButtons.map(btn => [btn]),
                    [{ text: '🔧 Skip to Claude UI', callback_data: `qskip:${approvalId}` }],
                ],
            }

            const sendResult = await this.telegramService.sendMessage(text, keyboard, 'HTML')
            if (!sendResult || !sendResult.message_id) {
                this.logger.eprint('[question] Failed to send question to Telegram')
                return null
            }
            const messageId = sendResult.message_id

            // Wait for response — button press or text reply
            const answer = await this.waitForQuestionAnswer(
                approvalId,
                sessionId,
                messageId,
                options
            )

            if (answer === null) {
                // User chose "Skip to Claude UI"
                return null
            }

            answers[questionText] = answer

            // If multi-question, edit message to show the answer was recorded
            if (questions.length > 1) {
                try {
                    const token = this.configManager.cfg().telegram_bot_token
                    const chatId = this.configManager.cfg().telegram_chat_id
                    await this.telegramService.tgApiWithToken(token, 'editMessageText', {
                        chat_id: chatId,
                        message_id: messageId,
                        text: `[${label}] ✅ <b>${this.escapeHtml(
                            q.header || 'Question'
                        )}</b> — ${this.escapeHtml(String(answer))}`,
                        parse_mode: 'HTML',
                    })
                } catch (e) {
                    this.logger.debugLog('QUESTION', 'Failed to edit question message', {
                        error: e.message,
                    })
                }
            }
        }

        this.sessionsService.appendHistory({
            type: 'question_answer',
            session_id: sessionId,
            answers,
        })

        return {
            hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: {
                    behavior: 'allow',
                    updatedInput: { answers },
                },
            },
        }
    }

    /**
     * Wait for question answer — button press or text reply
     * @param {string} approvalId - Unique approval ID for callback matching
     * @param {string} sessionId - Claude session ID
     * @param {number} messageId - Telegram message ID for reply matching
     * @param {Array} options - Question options array
     * @returns {string|null} Selected answer or null for skip
     */
    async waitForQuestionAnswer(approvalId, sessionId, messageId, options) {
        const configTimeout = this.configManager.cfg().timeout_seconds
        const timeout =
            configTimeout === 0 || configTimeout === -1
                ? 999999
                : Number(configTimeout || 3600)
        const hookId = `question-${approvalId}`
        const chatId = String(this.configManager.cfg().telegram_chat_id)

        // Set reply lock so text replies route to this session
        this.sessionsService.setReplyLock(sessionId, messageId)

        const messageFilter = update => {
            // Match button presses for this question
            if (update.callback_query) {
                const data = update.callback_query.data || ''
                return data.startsWith(`qopt:${approvalId}`) || data === `qskip:${approvalId}`
            }
            // Match text replies to the question message
            if (
                update.message &&
                update.message.text &&
                !update.message.text.startsWith('/')
            ) {
                if (String(update.message.chat.id) !== chatId) return false
                // Accept replies to the question message, or any text if this session owns the lock
                if (
                    update.message.reply_to_message &&
                    update.message.reply_to_message.message_id === messageId
                ) {
                    return true
                }
                return this.sessionsService.isMyMessage(sessionId, update.message)
            }
            return false
        }

        this.logger.eprint(`[${hookId}] Waiting for question answer...`)

        try {
            const update = await this.queueService.distributedTelegramPoll(
                messageFilter,
                hookId,
                sessionId,
                timeout * 1000,
                {
                    telegramService: this.telegramService,
                    sessionsService: this.sessionsService,
                    readMode: this.configManager.readMode.bind(this.configManager),
                }
            )

            if (!update) return null

            // Handle button press
            if (update.callback_query) {
                const data = update.callback_query.data || ''
                const token = this.configManager.cfg().telegram_bot_token

                // Ack the callback
                try {
                    await this.telegramService.tgApiWithToken(token, 'answerCallbackQuery', {
                        callback_query_id: update.callback_query.id,
                    })
                } catch (e) {
                    // non-fatal
                }

                if (data === `qskip:${approvalId}`) {
                    return null // fall through to Claude UI
                }

                // Parse qopt:approvalId:optionIndex
                const parts = data.split(':')
                const optIndex = parseInt(parts[2], 10)
                if (optIndex >= 0 && optIndex < options.length) {
                    return options[optIndex].label
                }
                return null
            }

            // Handle text reply
            if (update.message && update.message.text) {
                const text = update.message.text.trim()

                // Check if it's a number referencing an option
                if (/^\d+$/.test(text)) {
                    const idx = parseInt(text, 10) - 1
                    if (idx >= 0 && idx < options.length) {
                        return options[idx].label
                    }
                }

                // Check if it's comma-separated numbers (multiSelect)
                if (/^[\d,\s]+$/.test(text)) {
                    const indices = text
                        .split(',')
                        .map(s => parseInt(s.trim(), 10) - 1)
                        .filter(i => i >= 0 && i < options.length)
                    if (indices.length > 0) {
                        return indices.map(i => options[i].label).join(', ')
                    }
                }

                // Literal text answer
                return text
            }

            return null
        } catch (e) {
            this.logger.eprint(`[${hookId}] Error waiting for answer: ${e.message}`)
            return null
        } finally {
            this.sessionsService.clearReplyLock()
        }
    }

    /**
     * Stop hook handler for task completion
     * @param {Object} data - Hook input data from Claude Code
     */
    async handleStop(data) {
        const { session_id: sessionId, cwd } = data

        this.logger.eprint(
            `🛑 [afk] Stop hook triggered (session: ${sessionId?.substring(0, 8)}...)`
        )

        this.logger.debugLog('HOOK_STOP', 'Stop hook triggered', {
            sessionId,
            cwd,
            transcript_path: data.transcript_path,
        })

        // Check effective mode using hierarchy (session > project > global)
        const mode = this.getEffectiveMode(sessionId, cwd)
        if (mode === 'local') {
            this.logger.debugLog('HOOK_STOP', 'Local mode - no Telegram notification', {
                mode,
                reason: 'local mode active',
            })
            this.logger.eprint(`[afk] Local mode - no Stop notification sent`)
            return
        }

        // Send stop notification to Telegram
        const label = this.projectLabel(cwd)
        const context = this.extractConversationContext(data.transcript_path)

        // In readonly mode, send notification but don't wait
        if (mode === 'readonly') {
            this.logger.debugLog(
                'HOOK_STOP',
                'Read-only mode - sending notification without waiting',
                {
                    mode,
                    sessionId,
                }
            )
            await this.sendStopNotificationReadOnly(sessionId, label, cwd, context)
            this.logger.eprint(`📖 [afk] Read-only mode - Stop notification sent (no waiting)`)
            return
        }

        // Remote mode - send notification and wait for response
        await this.sendStopNotification(sessionId, label, cwd, context)
        await this.waitForStopResponse(sessionId, cwd)
    }

    /**
     * SessionStart hook handler for new sessions
     * @param {Object} data - Hook input data from Claude Code
     */
    async handleSessionStart(data) {
        const { session_id: sessionId, cwd, source } = data

        this.logger.eprint(
            `🚀 [afk] SessionStart hook triggered (session: ${sessionId?.substring(0, 8)}...)`
        )

        this.logger.debugLog('HOOK_SESSIONSTART', 'SessionStart hook triggered', {
            sessionId,
            cwd,
            source,
            transcript_path: data.transcript_path,
        })

        // Check effective mode using hierarchy (session > project > global)
        const mode = this.getEffectiveMode(sessionId, cwd)
        if (mode === 'local') {
            this.logger.debugLog(
                'HOOK_SESSIONSTART',
                'Local mode - no Telegram notification',
                {
                    mode,
                    reason: 'local mode active',
                }
            )
            this.logger.eprint(`[afk] Local mode - no SessionStart notification sent`)
            return
        }

        // Track active session
        this.sessionsService.trackActiveSession(sessionId, cwd)

        // Send session start notification
        const label = this.projectLabel(cwd)

        // In readonly mode, send notification but don't wait
        if (mode === 'readonly') {
            this.logger.debugLog(
                'HOOK_SESSIONSTART',
                'Read-only mode - sending notification without waiting',
                {
                    mode,
                    sessionId,
                }
            )
            await this.sendSessionStartNotificationReadOnly(sessionId, label, cwd, source)
            this.logger.eprint(
                `📖 [afk] Read-only mode - SessionStart notification sent (no waiting)`
            )
            return
        }

        // Remote mode - send notification and wait for response
        await this.sendSessionStartNotification(sessionId, label, cwd, source)
        const result = await this.waitForSessionStartResponse(sessionId, cwd)
        if (result && result.hookSpecificOutput) {
            process.stdout.write(JSON.stringify(result))
        }
    }

    // Helper methods (would be extracted from bin/afk)

    getApprovalDir() {
        return path.join(this.configManager.configDir, 'approvals')
    }

    projectLabel(cwd) {
        return path.basename(cwd) || 'project'
    }

    summarizeTool(toolName, toolInput) {
        if (toolInput.command) {
            const cmd = toolInput.command
            return `${toolName}: ${cmd.length > 100 ? cmd.substring(0, 100) + '...' : cmd}`
        }
        if (toolInput.file_path) {
            const rel = toolInput.file_path.replace(/.*\/(?=[^/]+\/[^/]+$)/, '')
            return `${toolName}: ${rel}`
        }
        return toolName
    }

    /**
     * Escape text for HTML parse_mode (only <, >, & need escaping)
     */
    escapeHtml(text) {
        if (!text) return ''
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    /**
     * Format tool detail section for the approval message (HTML)
     * Shows diffs for Edit, content preview for Write, command for Bash
     */
    formatToolDetail(toolName, toolInput) {
        const maxLen = 2500 // Leave room for the rest of the message (TG limit 4096)

        if (toolName === 'Edit' && toolInput.old_string != null) {
            const filePath = toolInput.file_path || ''
            const ext = path.extname(filePath).slice(1) || 'txt'
            const oldLines = toolInput.old_string.split('\n')
            const newLines = toolInput.new_string.split('\n')

            let diff = ''
            for (const line of oldLines) diff += `- ${line}\n`
            for (const line of newLines) diff += `+ ${line}\n`

            if (diff.length > maxLen) {
                diff = diff.substring(0, maxLen) + '\n... (truncated)'
            }

            return `<pre>${this.escapeHtml(diff)}</pre>`
        }

        if (toolName === 'Write' && toolInput.content != null) {
            let preview = toolInput.content
            if (preview.length > maxLen) {
                preview = preview.substring(0, maxLen) + '\n... (truncated)'
            }
            return `<pre>${this.escapeHtml(preview)}</pre>`
        }

        if (toolName === 'Bash' && toolInput.command) {
            let cmd = toolInput.command
            if (cmd.length > maxLen) {
                cmd = cmd.substring(0, maxLen) + '... (truncated)'
            }
            return `<pre>$ ${this.escapeHtml(cmd)}</pre>`
        }

        // For other tools, show a compact JSON of the input
        const inputStr = JSON.stringify(toolInput, null, 2)
        if (inputStr.length > maxLen) {
            return `<pre>${this.escapeHtml(inputStr.substring(0, maxLen))}...</pre>`
        }
        if (inputStr !== '{}') {
            return `<pre>${this.escapeHtml(inputStr)}</pre>`
        }
        return ''
    }

    extractConversationContext(transcriptPath, maxLines = 20) {
        if (!transcriptPath || !fs.existsSync(transcriptPath)) {
            return { error: 'No transcript available' }
        }

        try {
            const { execSync } = require('child_process')
            const lines = execSync(`tail -${maxLines} "${transcriptPath}"`, {
                encoding: 'utf8',
            })
                .trim()
                .split('\n')
                .filter(Boolean)

            const recentMessages = []
            let lastUserMessage = null
            let lastAssistantMessage = null

            for (const line of lines) {
                try {
                    const entry = JSON.parse(line)
                    if (!entry.message || !entry.message.role) continue

                    const role = entry.message.role
                    const content = entry.message.content

                    let text = ''
                    if (Array.isArray(content)) {
                        for (const item of content) {
                            if (item.type === 'text') {
                                text += item.text + ' '
                            } else if (item.type === 'tool_use') {
                                text += `[${item.name}: ${
                                    item.input
                                        ? Object.keys(item.input)[0] || 'action'
                                        : 'call'
                                }] `
                            }
                        }
                    } else if (typeof content === 'string') {
                        text = content
                    }

                    text = text.trim()
                    if (text && text.length > 3) {
                        const msg = {
                            role,
                            text: text,
                            timestamp: entry.timestamp,
                        }

                        recentMessages.push(msg)

                        if (role === 'user') lastUserMessage = msg
                        else if (role === 'assistant') lastAssistantMessage = msg
                    }
                } catch (e) {
                    continue
                }
            }

            const contextMessages = recentMessages.slice(-6)

            return {
                lastUserMessage,
                lastAssistantMessage,
                recentMessages: contextMessages,
                messageCount: contextMessages.length,
                totalLinesProcessed: lines.length,
            }
        } catch (e) {
            return { error: `Failed to read transcript: ${e.message}` }
        }
    }

    analyzeClaudeIntent(context, toolName, toolInput) {
        if (!context.lastAssistantMessage) {
            return null
        }

        const lastText = context.lastAssistantMessage.text.toLowerCase()

        if (
            lastText.includes('let me') ||
            lastText.includes("i'll") ||
            lastText.includes('i need to')
        ) {
            if (toolName === 'Write' || toolName === 'Edit') {
                return `💡 **Context:** Claude is working on file modifications`
            } else if (toolName === 'Bash') {
                const cmd = toolInput.command || ''
                if (cmd.includes('test')) {
                    return `💡 **Context:** Claude is running tests`
                } else if (cmd.includes('build') || cmd.includes('compile')) {
                    return `💡 **Context:** Claude is building the project`
                } else if (cmd.includes('git')) {
                    return `💡 **Context:** Claude is working with git`
                }
                return `💡 **Context:** Claude is running commands`
            }
        }

        if (
            lastText.includes('error') ||
            lastText.includes('fix') ||
            lastText.includes('debug')
        ) {
            return `🔧 **Context:** Claude is debugging/fixing issues`
        }

        if (lastText.includes('test') || lastText.includes('check')) {
            return `🧪 **Context:** Claude is testing functionality`
        }

        if (
            lastText.includes('create') ||
            lastText.includes('add') ||
            lastText.includes('new')
        ) {
            return `✨ **Context:** Claude is creating new functionality`
        }

        return null
    }

    shortSession(sessionId) {
        if (!sessionId) return '(unknown)'
        return String(sessionId).slice(-8)
    }

    async sendApprovalRequest(
        approvalId,
        toolName,
        toolInput,
        summary,
        patterns,
        label,
        sessionId,
        cwd,
        transcriptPath
    ) {
        // Extract conversation context
        const context = this.extractConversationContext(transcriptPath)
        const intent = this.analyzeClaudeIntent(context, toolName, toolInput)

        // Build headline: tool-specific one-liner
        let headline = ''
        if (toolName === 'Edit' && toolInput.file_path) {
            const rel = toolInput.file_path.replace(cwd + '/', '')
            headline = `<code>${this.escapeHtml(rel)}</code>`
        } else if (toolName === 'Write' && toolInput.file_path) {
            const rel = toolInput.file_path.replace(cwd + '/', '')
            headline = `<code>${this.escapeHtml(rel)}</code> (new)`
        } else if (toolName === 'Bash') {
            headline = '' // command shown in detail block
        } else {
            headline = this.escapeHtml(summary)
        }

        // Build context line (only if analyzeClaudeIntent found something specific)
        let contextLine = ''
        if (intent) {
            const cleanIntent = intent.replace(/\*\*/g, '').replace(/[💡🔧🧪✨🤖]\s*/g, '')
            contextLine = `\n<i>${this.escapeHtml(cleanIntent)}</i>`
        }

        // Build detail section (diff, command, etc.)
        const detail = this.formatToolDetail(toolName, toolInput)

        // Assemble message
        const parts = [`[${this.escapeHtml(label)}] 🤖 <b>Approval required</b>`]
        if (headline) parts.push(headline)
        if (contextLine) parts.push(contextLine)
        if (detail) parts.push('', detail)
        parts.push('')
        parts.push(
            `<code>${this.shortSession(sessionId)}</code> · <code>${this.escapeHtml(
                cwd
            )}</code>`
        )

        const text = parts.join('\n')

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '✅ Approve', callback_data: `approve:${approvalId}` },
                    { text: '❌ Deny', callback_data: `deny:${approvalId}` },
                ],
                [
                    { text: '✅ Allow All', callback_data: `allow_all:${approvalId}` },
                    { text: '🔧 Ask Claude UI', callback_data: `ask_ui:${approvalId}` },
                ],
            ],
        }

        return await this.telegramService.sendMessage(text, keyboard, 'HTML')
    }

    _formatSessionSource(source) {
        switch (source) {
            case 'startup':
                return '🆕 <b>New session started</b>'
            case 'resume':
                return '🔄 <b>Session resumed</b>'
            case 'clear':
                return '🧹 <b>Session cleared &amp; restarted</b>'
            default:
                return '🚀 <b>Session initialized</b>'
        }
    }

    _buildContextSection(context) {
        let contextSection = ''
        if (context.recentMessages && context.recentMessages.length > 0 && !context.error) {
            contextSection += `\n\n💬 <b>What happened:</b>`
            const messagesToShow = context.recentMessages.slice(-3)
            for (const msg of messagesToShow) {
                const roleIcon = msg.role === 'user' ? '👤' : '🤖'
                const safeText = this.escapeHtml(msg.text).substring(0, 500)
                contextSection += `\n${roleIcon} ${safeText}`
            }
        }
        return contextSection
    }

    async sendStopNotification(sessionId, label, cwd, context) {
        const contextSection = this._buildContextSection(context)

        const text = `[${this.escapeHtml(
            label
        )}] ✅ <b>Agent finished</b>${contextSection}\n\n<code>${this.shortSession(
            sessionId
        )}</code>\n\nTap <b>Reply</b> to send a follow-up, or <b>Finish</b> to close.`

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '💬 Reply', callback_data: `reply:${sessionId}` },
                    { text: '✅ Finish', callback_data: `finish:${sessionId}` },
                ],
            ],
        }

        return await this.telegramService.sendMessage(text, keyboard, 'HTML')
    }

    async sendSessionStartNotification(sessionId, label, cwd, source) {
        const sourceText = this._formatSessionSource(source)

        const text = `[${this.escapeHtml(label)}] ${sourceText}\n<code>${this.shortSession(
            sessionId
        )}</code> · <code>${this.escapeHtml(
            cwd
        )}</code>\n\nTap <b>Reply</b> to send initial instructions, or <b>Finish</b> to proceed without input.`

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '💬 Reply', callback_data: `reply:${sessionId}` },
                    { text: '✅ Finish', callback_data: `finish:${sessionId}` },
                ],
            ],
        }

        return await this.telegramService.sendMessage(text, keyboard, 'HTML')
    }

    async sendStopNotificationReadOnly(sessionId, label, cwd, context) {
        const contextSection = this._buildContextSection(context)

        const text = `[${this.escapeHtml(
            label
        )}] <b>Session completed</b>${contextSection}\n\n<code>${this.shortSession(
            sessionId
        )}</code>`

        return await this.telegramService.sendMessage(text, null, 'HTML')
    }

    async sendSessionStartNotificationReadOnly(sessionId, label, cwd, source) {
        const sourceText = this._formatSessionSource(source)

        const text = `[${this.escapeHtml(label)}] ${sourceText}\n<code>${this.shortSession(
            sessionId
        )}</code> · <code>${this.escapeHtml(cwd)}</code>`

        // No interactive buttons in read-only mode
        return await this.telegramService.sendMessage(text, null, 'HTML')
    }

    async waitForApproval(approvalId, sessionId, toolName, toolInput) {
        const configTimeout = this.configManager.cfg().timeout_seconds
        const timeoutAction = this.configManager.cfg().timeout_action || 'deny'
        const timeout =
            configTimeout === 0 || configTimeout === -1
                ? 999999
                : Number(configTimeout || 3600)

        const hookId = `approval-${approvalId}`

        const messageFilter = update => {
            if (!update.callback_query) return false
            const data = update.callback_query.data || ''
            return data.includes(approvalId)
        }

        const shouldWaitForever = timeoutAction === 'wait'
        const timeoutMs = shouldWaitForever ? 999999000 : timeout * 1000

        this.logger.eprint(`[${hookId}] Waiting for user response...`)

        const update = await this.queueService.distributedTelegramPoll(
            messageFilter,
            hookId,
            sessionId,
            timeoutMs,
            {
                telegramService: this.telegramService,
                sessionsService: this.sessionsService,
                readMode: this.configManager.readMode.bind(this.configManager),
            }
        )

        if (update && update.callback_query) {
            return await this.processToolApproval(update, approvalId, sessionId)
        }

        // Handle timeout
        if (timeoutAction === 'allow') {
            return {
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: { behavior: 'allow' },
                },
            }
        } else if (timeoutAction === 'deny') {
            return {
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: {
                        behavior: 'deny',
                        message: `Auto-denied after ${timeout}s timeout`,
                    },
                },
            }
        }

        // null = no opinion, fall through to normal Claude UI prompt
        return null
    }

    async waitForStopResponse(sessionId, cwd) {
        const timeout = Number(process.env.AFK_STOP_TIMEOUT || 21600)
        const hookId = `stop-${sessionId}`

        const messageFilter = update => {
            if (update.callback_query) {
                const data = update.callback_query.data || ''
                return (
                    data.startsWith('reply:' + sessionId) ||
                    data.startsWith('finish:' + sessionId)
                )
            }
            if (
                update.message &&
                update.message.text &&
                !update.message.text.startsWith('/')
            ) {
                const chatId = String(update.message.chat.id)
                const { telegram_chat_id } = this.configManager.cfg()
                return chatId === String(telegram_chat_id)
            }
            return false
        }

        this.logger.eprint(`🛑 [afk] Stop hook waiting for user response...`)

        const update = await this.queueService.distributedTelegramPoll(
            messageFilter,
            hookId,
            sessionId,
            timeout * 1000,
            {
                telegramService: this.telegramService,
                sessionsService: this.sessionsService,
                readMode: this.configManager.readMode.bind(this.configManager),
            }
        )

        if (update && update.callback_query) {
            const callbackData = update.callback_query.data || ''

            if (callbackData.startsWith('reply:')) {
                // Handle full reply flow like the binary version
                try {
                    await this.telegramService.tgApiWithToken(
                        this.configManager.cfg().telegram_bot_token,
                        'answerCallbackQuery',
                        {
                            callback_query_id: update.callback_query.id,
                        }
                    )

                    // Clear any existing lock first, then set new one for this session
                    this.sessionsService.clearReplyLock()
                    this.sessionsService.setReplyLock(
                        sessionId,
                        update.callback_query.message.message_id
                    )

                    // Update buttons with Stop Waiting option
                    await this.telegramService.tgApiWithToken(
                        this.configManager.cfg().telegram_bot_token,
                        'editMessageReplyMarkup',
                        {
                            chat_id: update.callback_query.message.chat.id,
                            message_id: update.callback_query.message.message_id,
                            reply_markup: JSON.stringify({
                                inline_keyboard: [
                                    [
                                        {
                                            text: '⏳ Waiting for your reply...',
                                            callback_data: 'waiting',
                                        },
                                        {
                                            text: '🛑 Stop Waiting',
                                            callback_data: `stop_wait:${sessionId}`,
                                        },
                                    ],
                                ],
                            }),
                        }
                    )
                } catch (e) {
                    this.logger.eprint(`[${hookId}] Error updating message:`, e.message)
                }

                // Wait for text message - create more specific filter for text messages with session locking
                const textMessageFilter = updateToCheck => {
                    if (
                        updateToCheck.message &&
                        updateToCheck.message.text &&
                        !updateToCheck.message.text.startsWith('/')
                    ) {
                        const chatId = String(updateToCheck.message.chat.id)
                        const { telegram_chat_id } = this.configManager.cfg()

                        // Only process messages from our configured chat
                        if (chatId !== String(telegram_chat_id)) {
                            return false
                        }

                        // Only accept messages when explicitly waiting after Reply button
                        if (
                            !this.sessionsService.isMyMessage(sessionId, updateToCheck.message)
                        ) {
                            return false
                        }

                        // We got a message and we own the lock - accept it
                        this.logger.eprint(
                            `[${hookId}] Got text message after Reply button click`
                        )
                        this.sessionsService.clearReplyLock()
                        return true
                    }
                    return false
                }

                const textUpdate = await this.queueService.distributedTelegramPoll(
                    textMessageFilter,
                    hookId + '-text',
                    sessionId,
                    timeout * 1000,
                    {
                        telegramService: this.telegramService,
                        sessionsService: this.sessionsService,
                        readMode: this.configManager.readMode.bind(this.configManager),
                    }
                )

                if (textUpdate && textUpdate.message && textUpdate.message.text) {
                    const userText = textUpdate.message.text
                    this.logger.eprint(
                        `💬 [afk] Stop hook: Got user message, continuing conversation`
                    )

                    // Update buttons to show we got the message
                    try {
                        await this.telegramService.tgApiWithToken(
                            this.configManager.cfg().telegram_bot_token,
                            'editMessageReplyMarkup',
                            {
                                chat_id: update.callback_query.message.chat.id,
                                message_id: update.callback_query.message.message_id,
                                reply_markup: JSON.stringify({
                                    inline_keyboard: [
                                        [
                                            {
                                                text: `💬 Received: "${userText.substring(
                                                    0,
                                                    30
                                                )}${userText.length > 30 ? '...' : ''}"`,
                                                callback_data: 'received',
                                            },
                                        ],
                                    ],
                                }),
                            }
                        )
                    } catch (e) {
                        this.logger.eprint(`[${hookId}] Error updating message:`, e.message)
                    }

                    this.sessionsService.appendHistory({
                        type: 'reply',
                        session_id: sessionId,
                        text: userText,
                    })
                    this.logger.eprint(
                        `✅ [afk] Stop hook completed - injecting user message into conversation`
                    )

                    // User clicked Reply - they want to continue with their message
                    // Inject the message and let Claude continue
                    process.stderr.write(
                        `User replied via Telegram: "${userText}". Continue the conversation with this input.`
                    )
                    process.exit(2)
                }
            } else if (callbackData.startsWith('finish:')) {
                // User wants to finish - allow Claude to stop
                try {
                    await this.telegramService.tgApiWithToken(
                        this.configManager.cfg().telegram_bot_token,
                        'answerCallbackQuery',
                        {
                            callback_query_id: update.callback_query.id,
                        }
                    )
                    // Just update buttons to show session finished
                    await this.telegramService.tgApiWithToken(
                        this.configManager.cfg().telegram_bot_token,
                        'editMessageReplyMarkup',
                        {
                            chat_id: update.callback_query.message.chat.id,
                            message_id: update.callback_query.message.message_id,
                            reply_markup: JSON.stringify({
                                inline_keyboard: [
                                    [
                                        {
                                            text: '✅ Session finished',
                                            callback_data: 'finished',
                                        },
                                    ],
                                ],
                            }),
                        }
                    )
                } catch (e) {
                    this.logger.eprint(`[${hookId}] Error updating message:`, e.message)
                }

                this.sessionsService.appendHistory({ type: 'finish', session_id: sessionId })
                this.logger.eprint(`✅ [afk] Stop hook completed - session finished`)

                return {}
            }
        }

        return {}
    }

    // Helper methods for mode management
    getSessionMode(sessionId) {
        const sessionDir = path.join(this.configManager.configDir, 'sessions', sessionId)
        const modeFile = path.join(sessionDir, 'mode')
        try {
            if (fs.existsSync(modeFile)) {
                return fs.readFileSync(modeFile, 'utf8').trim()
            }
        } catch (e) {
            this.logger.debugLog('SESSION_MODE', 'Failed to read session mode', {
                error: e.message,
            })
        }
        return null
    }

    setSessionMode(sessionId, mode) {
        const sessionDir = path.join(this.configManager.configDir, 'sessions', sessionId)
        const modeFile = path.join(sessionDir, 'mode')
        try {
            this.utils.ensureDir(sessionDir)
            fs.writeFileSync(modeFile, mode)
            this.logger.debugLog('SESSION_MODE', 'Session mode set', { sessionId, mode })
        } catch (e) {
            this.logger.eprint('Failed to set session mode:', e.message)
        }
    }

    clearSessionMode(sessionId) {
        const sessionDir = path.join(this.configManager.configDir, 'sessions', sessionId)
        const modeFile = path.join(sessionDir, 'mode')
        try {
            if (fs.existsSync(modeFile)) {
                fs.unlinkSync(modeFile)
                this.logger.debugLog('SESSION_MODE', 'Session mode cleared', { sessionId })
            }
        } catch (e) {
            this.logger.eprint('Failed to clear session mode:', e.message)
        }
    }

    getProjectMode(cwd) {
        if (!cwd) return null

        // Check for .afk/mode in project directory
        const projectModeFile = path.join(cwd, '.afk', 'mode')
        try {
            if (fs.existsSync(projectModeFile)) {
                return fs.readFileSync(projectModeFile, 'utf8').trim()
            }
        } catch (e) {
            this.logger.debugLog('PROJECT_MODE', 'Failed to read project mode', {
                error: e.message,
            })
        }

        // Also check .claude/afk-mode for compatibility
        const claudeModeFile = path.join(cwd, '.claude', 'afk-mode')
        try {
            if (fs.existsSync(claudeModeFile)) {
                return fs.readFileSync(claudeModeFile, 'utf8').trim()
            }
        } catch (e) {
            this.logger.debugLog('PROJECT_MODE', 'Failed to read .claude mode', {
                error: e.message,
            })
        }

        return null
    }

    setProjectMode(cwd, mode) {
        if (!cwd) return

        const projectDir = path.join(cwd, '.afk')
        const modeFile = path.join(projectDir, 'mode')
        try {
            this.utils.ensureDir(projectDir)
            fs.writeFileSync(modeFile, mode)
            this.logger.debugLog('PROJECT_MODE', 'Project mode set', { cwd, mode })
        } catch (e) {
            this.logger.eprint('Failed to set project mode:', e.message)
        }
    }

    clearProjectMode(cwd) {
        if (!cwd) return

        const modeFile = path.join(cwd, '.afk', 'mode')
        try {
            if (fs.existsSync(modeFile)) {
                fs.unlinkSync(modeFile)
                this.logger.debugLog('PROJECT_MODE', 'Project mode cleared', { cwd })
            }
        } catch (e) {
            this.logger.eprint('Failed to clear project mode:', e.message)
        }
    }

    // Updated method to get effective mode with hierarchy
    getEffectiveMode(sessionId, cwd) {
        const sessionMode = this.getSessionMode(sessionId)
        if (sessionMode) {
            this.logger.debugLog('EFFECTIVE_MODE', 'Using session mode', {
                sessionId,
                mode: sessionMode,
            })
            return sessionMode
        }

        const projectMode = this.getProjectMode(cwd)
        if (projectMode) {
            this.logger.debugLog('EFFECTIVE_MODE', 'Using project mode', {
                cwd,
                mode: projectMode,
            })
            return projectMode
        }

        const globalMode = this.configManager.readMode()
        this.logger.debugLog('EFFECTIVE_MODE', 'Using global mode', { mode: globalMode })
        return globalMode
    }

    async waitForSessionStartResponse(sessionId, cwd) {
        const timeout = Number(process.env.AFK_SESSIONSTART_TIMEOUT || 21600)
        const hookId = `sessionstart-${sessionId}`

        const messageFilter = update => {
            if (update.callback_query) {
                const data = update.callback_query.data || ''
                return (
                    data.startsWith('reply:' + sessionId) ||
                    data.startsWith('finish:' + sessionId)
                )
            }
            if (
                update.message &&
                update.message.text &&
                !update.message.text.startsWith('/')
            ) {
                const chatId = String(update.message.chat.id)
                const { telegram_chat_id } = this.configManager.cfg()
                return chatId === String(telegram_chat_id)
            }
            return false
        }

        this.logger.eprint(`⏳ [afk] SessionStart hook waiting for user response...`)

        const update = await this.queueService.distributedTelegramPoll(
            messageFilter,
            hookId,
            sessionId,
            timeout * 1000,
            {
                telegramService: this.telegramService,
                sessionsService: this.sessionsService,
                readMode: this.configManager.readMode.bind(this.configManager),
            }
        )

        if (update && update.callback_query) {
            const callbackData = update.callback_query.data || ''
            if (callbackData.startsWith('reply:')) {
                // Handle full reply flow for initial instructions
                try {
                    await this.telegramService.tgApiWithToken(
                        this.configManager.cfg().telegram_bot_token,
                        'answerCallbackQuery',
                        {
                            callback_query_id: update.callback_query.id,
                        }
                    )

                    // Clear any existing lock first, then set new one for this session
                    this.sessionsService.clearReplyLock()
                    this.sessionsService.setReplyLock(
                        sessionId,
                        update.callback_query.message.message_id
                    )

                    // Update buttons with waiting state
                    await this.telegramService.tgApiWithToken(
                        this.configManager.cfg().telegram_bot_token,
                        'editMessageReplyMarkup',
                        {
                            chat_id: update.callback_query.message.chat.id,
                            message_id: update.callback_query.message.message_id,
                            reply_markup: JSON.stringify({
                                inline_keyboard: [
                                    [
                                        {
                                            text: '⏳ Waiting for your instructions...',
                                            callback_data: 'waiting',
                                        },
                                        {
                                            text: '🛑 Stop Waiting',
                                            callback_data: `stop_wait:${sessionId}`,
                                        },
                                    ],
                                ],
                            }),
                        }
                    )
                } catch (e) {
                    this.logger.eprint(`[${hookId}] Error updating message:`, e.message)
                }

                // Wait for text message with session locking
                const textMessageFilter = updateToCheck => {
                    if (
                        updateToCheck.message &&
                        updateToCheck.message.text &&
                        !updateToCheck.message.text.startsWith('/')
                    ) {
                        const chatId = String(updateToCheck.message.chat.id)
                        const { telegram_chat_id } = this.configManager.cfg()

                        // Only process messages from our configured chat
                        if (chatId !== String(telegram_chat_id)) {
                            return false
                        }

                        // Only accept messages when explicitly waiting after Reply button
                        if (
                            !this.sessionsService.isMyMessage(sessionId, updateToCheck.message)
                        ) {
                            return false
                        }

                        // We got a message and we own the lock - accept it
                        this.logger.eprint(
                            `[${hookId}] Got initial instructions after Reply button click`
                        )
                        this.sessionsService.clearReplyLock()
                        return true
                    }
                    return false
                }

                const textUpdate = await this.queueService.distributedTelegramPoll(
                    textMessageFilter,
                    hookId + '-text',
                    sessionId,
                    timeout * 1000,
                    {
                        telegramService: this.telegramService,
                        sessionsService: this.sessionsService,
                        readMode: this.configManager.readMode.bind(this.configManager),
                    }
                )

                if (textUpdate && textUpdate.message && textUpdate.message.text) {
                    const userText = textUpdate.message.text
                    this.logger.eprint(`💬 [afk] SessionStart: Got initial instructions`)

                    try {
                        await this.telegramService.tgApiWithToken(
                            this.configManager.cfg().telegram_bot_token,
                            'editMessageReplyMarkup',
                            {
                                chat_id: update.callback_query.message.chat.id,
                                message_id: update.callback_query.message.message_id,
                                reply_markup: JSON.stringify({
                                    inline_keyboard: [
                                        [
                                            {
                                                text: `💬 Received: "${userText.substring(
                                                    0,
                                                    30
                                                )}${userText.length > 30 ? '...' : ''}"`,
                                                callback_data: 'received',
                                            },
                                        ],
                                    ],
                                }),
                            }
                        )
                    } catch (e) {
                        this.logger.eprint(`[${hookId}] Error updating message:`, e.message)
                    }

                    this.sessionsService.appendHistory({
                        type: 'session_start_reply',
                        session_id: sessionId,
                        text: userText,
                    })
                    this.logger.eprint(
                        `✅ [afk] Telegram instructions received. Type anything in Claude Code to start.`
                    )

                    // SessionStart hooks cannot use exit(2) to inject messages
                    // (exit 2 for SessionStart only shows stderr to user, unlike Stop hooks).
                    // Instead, use stdout + exit 0 with additionalContext, which
                    // SessionStart hooks add to Claude's context.
                    return {
                        hookSpecificOutput: {
                            hookEventName: 'SessionStart',
                            additionalContext: `The user provided initial instructions via Telegram: "${userText}". Act on these instructions.`,
                        },
                    }
                }
            } else if (callbackData.startsWith('finish:')) {
                // User wants to proceed without input
                try {
                    await this.telegramService.tgApiWithToken(
                        this.configManager.cfg().telegram_bot_token,
                        'answerCallbackQuery',
                        {
                            callback_query_id: update.callback_query.id,
                        }
                    )

                    await this.telegramService.tgApiWithToken(
                        this.configManager.cfg().telegram_bot_token,
                        'editMessageReplyMarkup',
                        {
                            chat_id: update.callback_query.message.chat.id,
                            message_id: update.callback_query.message.message_id,
                            reply_markup: JSON.stringify({
                                inline_keyboard: [
                                    [{ text: '✅ Session started', callback_data: 'started' }],
                                ],
                            }),
                        }
                    )
                } catch (e) {
                    this.logger.eprint(`[${hookId}] Error updating message:`, e.message)
                }

                return {}
            }
        }

        return {}
    }
}

module.exports = { ClaudeHooksService }
