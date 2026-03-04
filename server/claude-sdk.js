/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';
import { promises as fsPromises } from 'fs';
import fs from 'fs';
import { execSync, spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { CLAUDE_MODELS } from '../shared/modelConstants.js';
import { emitTaskEvent } from './ws-clients.js';
import { addStreamingChunk, finalizeStreamingMessage, addPendingPermission, removePendingPermission } from './session-state.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
const backgroundTasks = new Map(); // taskId -> task info
const backgroundTaskOutputs = new Map(); // taskId -> output string
const BACKGROUND_TASKS_MAX = 100;
const subagentMonitors = new Map(); // agentId -> interval handle

// Periodically remove task output files older than 3 days to prevent unbounded disk growth.
const TASK_OUTPUT_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // every hour
setInterval(async () => {
  const tasksDir = findClaudeTasksDir();
  if (!tasksDir) return;

  try {
    const files = await fsPromises.readdir(tasksDir);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith('.output')) continue;
      const filePath = path.join(tasksDir, file);
      try {
        const stat = await fsPromises.stat(filePath);
        if (now - stat.mtimeMs > TASK_OUTPUT_TTL_MS) {
          await fsPromises.unlink(filePath);
          console.log(`[CLEANUP] Removed stale task output: ${file}`);
        }
      } catch (e) { /* file may have been removed between readdir and stat */ }
    }
  } catch (e) {
    console.error('[CLEANUP] Error cleaning task outputs:', e.message);
  }
}, CLEANUP_INTERVAL_MS).unref(); // unref so this timer doesn't keep the process alive

/**
 * Returns the fallback tasks directory path for the current platform.
 * Used when findClaudeTasksDir() returns null (e.g. CLI has cleaned up the dir).
 */
function getFallbackTasksDir() {
  if (process.platform === 'win32') {
    const drive = process.cwd()[0];
    return path.join(`${drive}:\\tmp`, 'claude', 'tasks');
  }
  return '/tmp/claude/tasks';
}

/**
 * Find the Claude Code tasks output directory.
 * Claude CLI writes output files to <tmpdir>/claude/tasks/<agentId>.output
 * The tmpdir varies by platform and environment.
 */
function findClaudeTasksDir() {
  const candidates = [
    // Windows: Claude CLI often uses /tmp which maps to <drive>:\tmp in Git Bash
    ...(/^[A-Z]:/i.test(process.cwd()) ? [`${process.cwd().slice(0, 2)}/tmp/claude/tasks`] : []),
    'E:/tmp/claude/tasks',
    'C:/tmp/claude/tasks',
    'D:/tmp/claude/tasks',
    '/tmp/claude/tasks',
    path.join(os.tmpdir(), 'claude', 'tasks'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Find the subagent transcript file (agent-<agentId>.jsonl) in ~/.claude/projects/.
 * Caches the result to avoid repeated filesystem searches.
 */
const transcriptPathCache = new Map();
function findTranscriptPath(agentId) {
  if (transcriptPathCache.has(agentId)) return transcriptPathCache.get(agentId);

  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const filename = `agent-${agentId}.jsonl`;

  try {
    const findCmd = process.platform === 'win32'
      ? `powershell -Command "Get-ChildItem -Path '${projectsDir}' -Recurse -Filter '${filename}' | Select-Object -First 1 -ExpandProperty FullName"`
      : `find "${projectsDir}" -name "${filename}" -type f | head -1`;

    const result = execSync(findCmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result && fs.existsSync(result)) {
      transcriptPathCache.set(agentId, result);
      return result;
    }
  } catch (e) { /* not found yet */ }
  return null;
}

/**
 * Monitors a subagent for completion by checking the output file.
 *
 * Completion detection: Claude CLI writes <tmpdir>/claude/tasks/<agentId>.output
 * when a subagent finishes. The file contains tool call logs followed by
 * "--- RESULT ---" and the final output text.
 *
 * Progress tracking: The transcript file (agent-<agentId>.jsonl) in
 * ~/.claude/projects/<project>/ is read for intermediate progress.
 *
 * @param {string} agentId - The subagent ID
 * @param {string} toolUseId - The tool_use ID for this Task
 * @param {object} ws - WebSocket connection to send updates
 */
function monitorSubagentCompletion(agentId, toolUseId, ws) {
  const tasksDir = findClaudeTasksDir();
  const outputFile = tasksDir ? path.join(tasksDir, `${agentId}.output`) : null;

  console.log(`[SUBAGENT] Monitor started for ${agentId}, output file: ${outputFile || 'dir not found'}`);

  let fd = null;        // File descriptor — null until file appears
  let lastTranscriptLines = 0;

  const interval = setInterval(() => {
    try {
      // 1. Try to open fd when output file first appears
      if (outputFile && fd === null) {
        try {
          fd = fs.openSync(outputFile, 'r');
          console.log(`[SUBAGENT] Opened fd for ${agentId}`);
        } catch (e) { /* file not ready yet */ }
      }

      // 2. Check completion via fd (works even after path is unlinked by CLI)
      if (fd !== null) {
        const stat = fs.fstatSync(fd);
        if (stat.size > 0) {
          const buffer = Buffer.alloc(stat.size);
          fs.readSync(fd, buffer, 0, stat.size, 0);
          const content = buffer.toString('utf-8');

          if (content.includes('--- RESULT ---')) {
            // Extract result after the separator
            const resultText = content.split('--- RESULT ---')[1]?.trim() || '';
            const toolLog = content.split('--- RESULT ---')[0]?.trim() || '';

            console.log(`[SUBAGENT] ${agentId} completed, result length: ${resultText.length}`);

            clearInterval(interval);
            subagentMonitors.delete(agentId);
            transcriptPathCache.delete(agentId);

            // Close fd before caching
            try { fs.closeSync(fd); } catch (_) {}
            fd = null;

            // Store output
            backgroundTaskOutputs.set(toolUseId, {
              type: 'inline',
              content: resultText,
              toolLog,
              agentId
            });

            // Write cached content back to disk immediately (secondary safeguard)
            restoreTaskOutputFiles().catch(e => {
              console.warn(`[SUBAGENT] restoreTaskOutputFiles failed: ${e.message}`);
            });

            // Update task status
            const task = backgroundTasks.get(toolUseId);
            if (task) {
              task.status = 'completed';
              task.endTime = Date.now();
              evictOldestCompletedTasks();
            }

            // Notify frontend via at-least-once delivery
            const taskSessionId = task?.sessionId || null;
            if (taskSessionId) {
              emitTaskEvent(taskSessionId, {
                type: 'subagent-completed',
                agentId,
                taskId: toolUseId,
                output: resultText,
                toolLog
              });
              emitTaskEvent(taskSessionId, {
                type: 'background-task-completed',
                taskId: toolUseId
              });
            }
            // Output is cached in backgroundTaskOutputs for retrieval via query-task-output.
            // Do NOT inject as user prompt -- that would create a spurious chat message.
            return;
          }
        }
      }

      // 3. Read transcript for progress updates
      const transcriptPath = findTranscriptPath(agentId);
      if (!transcriptPath) return;

      const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
      if (lines.length <= lastTranscriptLines) return; // no new lines

      // Send new lines as progress
      const newLines = lines.slice(lastTranscriptLines);
      lastTranscriptLines = lines.length;

      const progressMessages = [];
      for (const line of newLines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'tool_use') {
                progressMessages.push({
                  type: 'tool_use',
                  tool: block.name,
                  input: block.input
                });
              } else if (block.type === 'text' && block.text) {
                progressMessages.push({
                  type: 'text',
                  text: block.text.slice(0, 500)
                });
              }
            }
          }
        } catch (e) { /* skip unparseable lines */ }
      }

      if (progressMessages.length > 0) {
        ws.send({
          type: 'subagent-progress',
          agentId,
          taskId: toolUseId,
          messages: progressMessages
        });
      }
    } catch (e) {
      console.error(`[SUBAGENT] Error monitoring ${agentId}:`, e.message);
    }
  }, 2000); // Poll every 2 seconds

  subagentMonitors.set(agentId, interval);

  // Safety: stop monitoring after 1 hour, close fd
  setTimeout(() => {
    if (subagentMonitors.has(agentId)) {
      console.log(`[SUBAGENT] Monitor timeout for ${agentId}, stopping`);
      clearInterval(interval);
      subagentMonitors.delete(agentId);
      transcriptPathCache.delete(agentId);
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_) {}
      }
    }
  }, 60 * 60 * 1000);
}

const bashMonitors = new Map(); // taskId -> interval handle

/**
 * Monitors a background bash task's output file for completion.
 * When the file stops growing, the process has exited.
 *
 * @param {string} taskId - The tool_use ID
 * @param {string} outputPath - Path to the output file
 * @param {object} ws - WebSocket connection
 */
function monitorBackgroundBash(taskId, outputPath, ws) {
  console.log(`[BASH-MONITOR] Started for ${taskId}, output: ${outputPath}`);

  let fd = null;        // File descriptor — null until file appears
  let lastSize = -1;
  let stableCount = 0;
  const STABLE_THRESHOLD = 3; // File unchanged for 3 checks (6 seconds) = done

  // Persistent path: CLI never deletes ~/.claude/task-outputs/; survives across sessions.
  const persistentDir = getFallbackTasksDir();
  const persistentPath = path.join(persistentDir, path.basename(outputPath));
  let persistentWritten = false; // Track if we've done the early write

  const interval = setInterval(() => {
    try {
      // Try to open fd if we don't have one yet
      if (fd === null) {
        try {
          fd = fs.openSync(outputPath, 'r');
          console.log(`[BASH-MONITOR] Opened fd for ${taskId}`);
        } catch (e) {
          return; // File doesn't exist yet, keep polling
        }
      }

      // Check size via fd (works even after path is unlinked by CLI)
      const stat = fs.fstatSync(fd);
      const currentSize = stat.size;

      if (currentSize === lastSize) {
        stableCount++;
      } else {
        stableCount = 0;
        lastSize = currentSize;
      }

      // Early write: as soon as ANY content appears, write to persistent location.
      // This makes the output available to follow-up sessions before stability is confirmed.
      if (currentSize > 0 && !persistentWritten) {
        try {
          const buf = Buffer.alloc(currentSize);
          fs.readSync(fd, buf, 0, currentSize, 0);
          fs.mkdirSync(persistentDir, { recursive: true });
          fs.writeFileSync(persistentPath, buf.toString('utf-8'), 'utf-8');
          persistentWritten = true;
          console.log(`[BASH-MONITOR] Early persistent write for ${taskId} (${currentSize} bytes)`);
        } catch (e) {
          console.warn(`[BASH-MONITOR] Early persistent write failed: ${e.message}`);
        }
      }

      if (stableCount >= STABLE_THRESHOLD && currentSize > 0) {
        console.log(`[BASH-MONITOR] ${taskId} completed (file stable at ${currentSize} bytes)`);

        clearInterval(interval);
        bashMonitors.delete(taskId);

        const task = backgroundTasks.get(taskId);

        // Read the output via fd (works even after CLI unlinks the path)
        let outputContent = '';
        try {
          const buffer = Buffer.alloc(currentSize);
          fs.readSync(fd, buffer, 0, currentSize, 0);
          outputContent = buffer.toString('utf-8');
          // Cache as inline content so query-task-output still works even if file is deleted.
          // filePath is preserved so restoreTaskOutputFiles() can write it back after CLI cleanup.
          backgroundTaskOutputs.set(taskId, {
            type: 'inline',
            content: outputContent,
            command: task?.input?.command || '',
            filePath: outputPath
          });
        } catch (e) {
          console.warn(`[BASH-MONITOR] Could not read output via fd: ${e.message}`);
        } finally {
          try { fs.closeSync(fd); } catch (_) {}
          fd = null;
        }

        // Overwrite persistent fallback with final stable content
        if (outputContent) {
          try {
            fs.mkdirSync(persistentDir, { recursive: true });
            fs.writeFileSync(persistentPath, outputContent, 'utf-8');
          } catch (e) {
            console.warn(`[BASH-MONITOR] Persistent final write failed: ${e.message}`);
          }
        }

        // Write cached content back to disk immediately (secondary safeguard, before CLI cleanup)
        restoreTaskOutputFiles().catch(e => {
          console.warn(`[BASH-MONITOR] restoreTaskOutputFiles failed: ${e.message}`);
        });

        // Update task status and notify frontend via at-least-once delivery
        if (task) {
          task.status = 'completed';
          task.endTime = Date.now();
          evictOldestCompletedTasks();

          const command = task.input?.command || '';
          // Include full output (capped at 50KB to avoid WS frame overflow)
          const OUTPUT_CAP = 50000;
          const outputSnippet = outputContent
            ? outputContent.length > OUTPUT_CAP
              ? outputContent.slice(-OUTPUT_CAP) + `\n... (truncated, showing last ${OUTPUT_CAP} chars)`
              : outputContent
            : '';

          if (task.sessionId) {
            emitTaskEvent(task.sessionId, {
              type: 'bash-completed',
              bash: { id: taskId, endTime: Date.now(), command },
              background: true,
              outputSnippet
            });
          }
        }
      }
    } catch (e) {
      console.error(`[BASH-MONITOR] Error monitoring ${taskId}:`, e.message);
    }
  }, 2000);

  bashMonitors.set(taskId, interval);

  // Safety: stop after 1 hour, close fd
  setTimeout(() => {
    if (bashMonitors.has(taskId)) {
      console.log(`[BASH-MONITOR] Timeout for ${taskId}, stopping`);
      clearInterval(interval);
      bashMonitors.delete(taskId);
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_) {}
      }
    }
  }, 60 * 60 * 1000);
}

/**
 * Evicts oldest completed tasks when backgroundTasks exceeds the size limit.
 * Only removes entries with status === 'completed'; running tasks are never evicted.
 */
function evictOldestCompletedTasks() {
  if (backgroundTasks.size <= BACKGROUND_TASKS_MAX) return;

  for (const [taskId, task] of backgroundTasks) {
    if (backgroundTasks.size <= BACKGROUND_TASKS_MAX) break;
    if (task.status === 'completed') {
      backgroundTasks.delete(taskId);
    }
  }
}

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || (8 * 60 * 60 * 1000); // 8 hours (28800000ms)

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion']);

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, toolName, input, sessionId, context } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    // Store approval data along with resolver function
    pendingToolApprovals.set(requestId, {
      toolName,
      input,
      sessionId,
      context,
      createdAt: Date.now(),
      resolve: (decision) => {
        finalize(decision);
      }
    });
  });
}

function resolveToolApproval(requestId, decision) {
  const approval = pendingToolApprovals.get(requestId);
  if (approval && approval.resolve) {
    console.log(`[PERMISSION] Resolving approval for requestId: ${requestId}, decision:`, decision);

    // Remove pending permission from session state
    if (approval.sessionId) {
      removePendingPermission(approval.sessionId, requestId);
    }

    approval.resolve(decision);
  } else {
    console.log(`[PERMISSION] No pending approval found for requestId: ${requestId}`);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * Maps CLI options to SDK-compatible options format
 * @param {Object} options - CLI options
 * @returns {Object} SDK-compatible options
 */
function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode, images } = options;

  const sdkOptions = {};

  // Map working directory
  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Map permission mode
  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  // Map tool settings
  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  // Handle tool permissions
  if (settings.skipPermissions && permissionMode !== 'plan') {
    // When skipping permissions, use bypassPermissions mode
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  // Add plan mode default tools
  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  // Enable partial/streaming message events for real-time text streaming
  sdkOptions.includePartialMessages = true;

  // Map model (default to sonnet)
  // Valid models: sonnet, opus, haiku, opusplan, sonnet[1m]
  sdkOptions.model = options.model || CLAUDE_MODELS.DEFAULT;
  console.log(`Using model: ${sdkOptions.model}`);

  // Map system prompt configuration
  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'  // Required to use CLAUDE.md
  };

  // Note: if TaskOutput returns "No task found", the output file from the original
  // tool_result may still exist on disk. Use Read or Bash (cat/tail) on the file path directly.
  const taskOutputFallbackHint = '\n\nIf TaskOutput returns "No task found", the output file may still exist at the path shown in the original tool_result. Use the Read tool or Bash (cat/tail/grep) to access it directly.';

  // Add skill content to system prompt if provided
  if (options.skillContent) {
    sdkOptions.systemPrompt.append = options.skillContent + taskOutputFallbackHint;
  } else {
    sdkOptions.systemPrompt.append = taskOutputFallbackHint;
  }

  // Map setting sources for CLAUDE.md loading
  // This loads CLAUDE.md from project, user (~/.config/claude/CLAUDE.md), and local directories
  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Map resume session
  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  // Allow Claude's Read/Bash tools to access task output directories.
  // The Claude CLI enforces a path whitelist — only cwd and explicitly listed directories
  // are accessible. Background task output files land in /tmp/claude/tasks/ (Linux) or
  // <drive>:\tmp\claude\tasks\ (Windows), which is outside cwd and thus blocked by default.
  {
    const taskDirsToAllow = new Set();
    const detected = findClaudeTasksDir();
    if (detected) taskDirsToAllow.add(detected);
    taskDirsToAllow.add(getFallbackTasksDir());
    sdkOptions.additionalDirectories = Array.from(taskDirsToAllow);
  }

  // Strip CLAUDECODE from the spawned CLI environment.
  // PM2 (or any parent Claude Code session) may have CLAUDECODE=1 set, which causes
  // CLI 2.1.50+ to refuse to start with "Claude Code cannot be launched inside another
  // Claude Code session." The web server is not itself a Claude Code session, so we
  // remove it before spawning.
  sdkOptions.spawnClaudeCodeProcess = ({ command, args, cwd, env, signal }) => {
    const cleanEnv = { ...env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    return spawn(command, args, { cwd, env: cleanEnv, signal });
  };

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Array<string>} tempImagePaths - Temp image file paths for cleanup
 * @param {string} tempDir - Temp directory for cleanup
 */
function addSession(sessionId, queryInstance, tempImagePaths = [], tempDir = null, writer = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir,
    writer
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * Extracts token usage from SDK result messages
 * @param {Object} resultMessage - SDK result message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(resultMessage) {
  if (resultMessage.type !== 'result' || !resultMessage.modelUsage) {
    return null;
  }

  // Get the first model's usage data
  const modelKey = Object.keys(resultMessage.modelUsage)[0];
  const modelData = resultMessage.modelUsage[modelKey];

  if (!modelData) {
    return null;
  }

  // Use cumulative tokens if available (tracks total for the session)
  // Otherwise fall back to per-request tokens
  const inputTokens = modelData.cumulativeInputTokens || modelData.inputTokens || 0;
  const outputTokens = modelData.cumulativeOutputTokens || modelData.outputTokens || 0;
  const cacheReadTokens = modelData.cumulativeCacheReadInputTokens || modelData.cacheReadInputTokens || 0;
  const cacheCreationTokens = modelData.cumulativeCacheCreationInputTokens || modelData.cacheCreationInputTokens || 0;

  // Total used = input + output + cache tokens
  const totalUsed = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  // Use configured context window budget from environment (default 160000)
  // This is the user's budget limit, not the model's context window
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW) || 160000;

  console.log(`Token calculation: input=${inputTokens}, output=${outputTokens}, cache=${cacheReadTokens + cacheCreationTokens}, total=${totalUsed}/${contextWindow}`);

  return {
    used: totalUsed,
    total: contextWindow
  };
}

/**
 * Handles image processing for SDK queries
 * Saves base64 images to temporary files and returns modified prompt with file paths
 * @param {string} command - Original user prompt
 * @param {Array} images - Array of image objects with base64 data
 * @param {string} cwd - Working directory for temp file creation
 * @returns {Promise<Object>} {modifiedCommand, tempImagePaths, tempDir}
 */
async function handleImages(command, images, cwd) {
  const tempImagePaths = [];
  let tempDir = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    // Create temp directory in the project directory
    const workingDir = cwd || process.cwd();
    tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
    await fsPromises.mkdir(tempDir, { recursive: true });

    // Save each image to a temp file
    for (const [index, image] of images.entries()) {
      // Extract base64 data and mime type
      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('Invalid image data format');
        continue;
      }

      const [, mimeType, base64Data] = matches;
      const extension = mimeType.split('/')[1] || 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);

      // Write base64 data to file
      await fsPromises.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    // Include the full image paths in the prompt
    let modifiedCommand = command;
    if (tempImagePaths.length > 0 && command && command.trim()) {
      const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = command + imageNote;
    }

    console.log(`Processed ${tempImagePaths.length} images to temp directory: ${tempDir}`);
    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('Error processing images for SDK:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

/**
 * Cleans up temporary image files
 * @param {Array<string>} tempImagePaths - Array of temp file paths to delete
 * @param {string} tempDir - Temp directory to remove
 */
async function cleanupTempFiles(tempImagePaths, tempDir) {
  if (!tempImagePaths || tempImagePaths.length === 0) {
    return;
  }

  try {
    // Delete individual temp files
    for (const imagePath of tempImagePaths) {
      await fsPromises.unlink(imagePath).catch(err =>
        console.error(`Failed to delete temp image ${imagePath}:`, err)
      );
    }

    // Delete temp directory
    if (tempDir) {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(err =>
        console.error(`Failed to delete temp directory ${tempDir}:`, err)
      );
    }

    console.log(`Cleaned up ${tempImagePaths.length} temp image files`);
  } catch (error) {
    console.error('Error during temp file cleanup:', error);
  }
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fsPromises.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      console.log('No ~/.claude.json found, proceeding without MCP servers');
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fsPromises.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      console.log(`Loaded ${Object.keys(mcpServers).length} global MCP servers`);
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        console.log(`Loaded ${Object.keys(projectConfig.mcpServers).length} project-specific MCP servers`);
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      console.log('No MCP servers configured');
      return null;
    }

    console.log(`Total MCP servers loaded: ${Object.keys(mcpServers).length}`);
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Restores task output files that were cleaned up by the CLI after session end.
 *
 * The Claude CLI writes <tmpdir>/claude/tasks/<id>.output files and then deletes
 * them when the process exits. We cache the content in backgroundTaskOutputs before
 * the CLI exits; this function writes the cached content back so the next session
 * can read it with Read/Bash even if TaskOutput itself can't find the task.
 */
async function restoreTaskOutputFiles() {
  if (backgroundTaskOutputs.size === 0) return;

  let tasksDir = findClaudeTasksDir();
  const fallbackDir = getFallbackTasksDir();

  // Ensure at least the fallback dir exists if the CLI-created one is gone
  if (!tasksDir) {
    try {
      await fsPromises.mkdir(fallbackDir, { recursive: true });
      tasksDir = fallbackDir;
    } catch (e) {
      console.error('[RESTORE] Failed to create fallback tasks dir:', e.message);
      return;
    }
  }

  for (const [taskId, output] of backgroundTaskOutputs) {
    if (output.type !== 'inline' || !output.content) continue;

    // Determine the file path to restore to
    let outputFile;
    if (output.filePath) {
      // Background bash task: original path was captured when monitor started
      outputFile = output.filePath;
    } else if (output.agentId) {
      // Subagent task: file is <tasksDir>/<agentId>.output
      outputFile = path.join(tasksDir, `${output.agentId}.output`);
    } else {
      continue; // No file path info — skip
    }

    // Only restore if the file is gone (future-safe: if CLI stops deleting, skip)
    if (!fs.existsSync(outputFile)) {
      try {
        await fsPromises.mkdir(path.dirname(outputFile), { recursive: true });
        await fsPromises.writeFile(outputFile, output.content, 'utf-8');
        console.log(`[RESTORE] Wrote task output to ${outputFile}`);
      } catch (e) {
        console.error(`[RESTORE] Failed to write ${outputFile}:`, e.message);
      }
    }
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  let tempImagePaths = [];
  let tempDir = null;

  const activeBashToolIds = new Set();
  const backgroundBashToolIds = new Set();

  try {
    // Map CLI options to SDK format
    const sdkOptions = mapCliOptionsToSDK(options);

    // Load MCP configuration
    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Handle images - save to temp files and modify prompt
    const imageResult = await handleImages(command, options.images, options.cwd);
    const finalCommand = imageResult.modifiedCommand;
    tempImagePaths = imageResult.tempImagePaths;
    tempDir = imageResult.tempDir;

    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      console.log(`[PERMISSION] Sending permission request for ${toolName}, requestId: ${requestId}, sessionId: ${capturedSessionId || sessionId || null}`);

      // Add pending permission to session state
      addPendingPermission(capturedSessionId || sessionId, { requestId, toolName, input });

      ws.send({
        type: 'claude-permission-request',
        requestId,
        toolName,
        input,
        sessionId: capturedSessionId || sessionId || null
      });

      console.log(`[PERMISSION] Waiting for approval decision for ${toolName}, requestId: ${requestId}`);
      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        toolName,
        input,
        sessionId: capturedSessionId || sessionId || null,
        context,
        onCancel: (reason) => {
          console.log(`[PERMISSION] Permission request cancelled for ${toolName}, requestId: ${requestId}, reason: ${reason}`);
          ws.send({
            type: 'claude-permission-cancelled',
            requestId,
            reason,
            sessionId: capturedSessionId || sessionId || null
          });
        }
      });

      console.log(`[PERMISSION] Received decision for ${toolName}, requestId: ${requestId}, decision:`, decision);

      if (!decision) {
        console.log(`[PERMISSION] No decision received (timeout) for ${toolName}, requestId: ${requestId}`);
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        console.log(`[PERMISSION] Decision cancelled for ${toolName}, requestId: ${requestId}`);
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        console.log(`[PERMISSION] Permission allowed for ${toolName}, requestId: ${requestId}`);
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      console.log(`[PERMISSION] Permission denied for ${toolName}, requestId: ${requestId}`);
      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // Set stream-close timeout for interactive tools (Query constructor reads it synchronously). Claude Agent SDK has a default of 5s and this overrides it
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    const queryInstance = query({
      prompt: finalCommand,
      options: sdkOptions
    });

    // Restore immediately — Query constructor already captured the value
    if (prevStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }

    // Track the query instance for abort capability
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    let messageCount = 0;
    for await (const message of queryInstance) {
      messageCount++;
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send({
            type: 'session-created',
            sessionId: capturedSessionId
          });
        } else {
          console.log('Not sending session-created. sessionId:', sessionId, 'sessionCreatedSent:', sessionCreatedSent);
        }
      } else {
        console.log('No session_id in message or already captured. message.session_id:', message.session_id, 'capturedSessionId:', capturedSessionId);
      }

      // Transform and send message to WebSocket
      const transformedMessage = transformMessage(message);

      // Accumulate streaming text chunks for session state
      if (transformedMessage && transformedMessage.content) {
        for (const contentBlock of transformedMessage.content || []) {
          if (contentBlock.type === 'text' && contentBlock.text) {
            addStreamingChunk(capturedSessionId || sessionId, contentBlock.text);
          }
        }
      }

      ws.send({
        type: 'claude-response',
        data: transformedMessage,
        sessionId: capturedSessionId || sessionId || null
      });

      // Detect background tasks (Task/Bash with run_in_background=true)
      const messageData = message.message || message;
      if (messageData && Array.isArray(messageData.content)) {
        messageData.content.forEach((part) => {
          if (part.type === 'tool_use') {
            const toolName = part.name;
            const toolInput = part.input;
            const toolId = part.id;

            // Track all Bash commands
            if (toolName === 'Bash') {
              activeBashToolIds.add(toolId);
              // Track background bash commands separately — these won't get bash-completed
              // because CLI returns tool_result immediately while command keeps running
              if (toolInput.run_in_background) {
                backgroundBashToolIds.add(toolId);

                // Also add to backgroundTasks for kill-task functionality
                const taskInfo = {
                  taskId: toolId,
                  toolName: 'Bash',
                  input: toolInput,
                  sessionId: capturedSessionId || sessionId || null,
                  startTime: Date.now(),
                  status: 'running'
                };
                backgroundTasks.set(toolId, taskInfo);
                evictOldestCompletedTasks();
              }
              // Only send bash-started to frontend for background bash tasks
              if (toolInput.run_in_background) {
                ws.send({
                  type: 'bash-started',
                  sessionId: capturedSessionId || sessionId || null,
                  bash: {
                    id: toolId,
                    command: toolInput.command,
                    description: toolInput.description,
                    run_in_background: true,
                    startTime: Date.now()
                  }
                });
              }
            }

            // Check if this is a background task (non-Bash tools only — Bash uses bash-started)
            if (toolInput && toolInput.run_in_background && toolName !== 'Bash') {
              const taskInfo = {
                taskId: toolId,
                toolName,
                input: toolInput,
                sessionId: capturedSessionId || sessionId || null,
                startTime: Date.now(),
                status: 'running'
              };

              backgroundTasks.set(toolId, taskInfo);
              evictOldestCompletedTasks();

              ws.send({
                type: 'background-task-started',
                sessionId: capturedSessionId || sessionId || null,
                task: taskInfo
              });
            }
          }

          // Detect task completion (tool_result for background tasks and bash commands)
          if (part.type === 'tool_result') {
            const toolUseId = part.tool_use_id;

            // Capture output for background bash tasks
            if (backgroundBashToolIds.has(toolUseId)) {
              const rawContent = typeof part.content === 'string' ? part.content
                : Array.isArray(part.content) ? part.content.map(c => c.text || '').join('')
                : '';

              // Parse output file path from CLI response like:
              // "Command running in background with ID: xxx. Output is being written to: /path/to/file"
              const outputFileMatch = rawContent.match(/Output is being written to:\s*(\S+)/);
              let outputPath = null;
              if (outputFileMatch) {
                // Resolve /tmp/ to Windows path
                // On Windows with Git Bash, /tmp maps to E:\tmp (or current drive:\tmp)
                outputPath = outputFileMatch[1];
                if (outputPath.startsWith('/tmp/') && process.platform === 'win32') {
                  // Convert /tmp/... to E:\tmp\... (or current drive)
                  const driveLetter = process.cwd()[0]; // Get current drive letter
                  outputPath = outputPath.replace('/tmp/', `${driveLetter}:\\tmp\\`).replace(/\//g, '\\');
                }

                // Get command text from backgroundTasks
                const task = backgroundTasks.get(toolUseId);
                const commandText = task?.input?.command || '';

                backgroundTaskOutputs.set(toolUseId, {
                  type: 'file',
                  path: outputPath,
                  command: commandText
                });
              }
              // Always store the raw CLI response
              if (rawContent) {
                const existing = backgroundTaskOutputs.get(toolUseId);
                if (existing) {
                  existing.cliResponse = rawContent;
                } else {
                  backgroundTaskOutputs.set(toolUseId, { type: 'inline', content: rawContent });
                }
              }

              // Start monitoring background bash output file for completion
              if (outputPath) {
                monitorBackgroundBash(toolUseId, outputPath, ws);
              }
            }

            // Send bash-completed for tracked bash commands (skip background ones — they keep running)
            if (activeBashToolIds.has(toolUseId) && !backgroundBashToolIds.has(toolUseId)) {
              activeBashToolIds.delete(toolUseId);
              ws.send({
                type: 'bash-completed',
                sessionId: capturedSessionId || sessionId || null,
                bash: { id: toolUseId, endTime: Date.now() }
              });
            }

            const task = backgroundTasks.get(toolUseId);

            if (task && !backgroundBashToolIds.has(toolUseId)) {
              // This is a Task tool (subagent) completion
              const rawContent = typeof part.content === 'string' ? part.content
                : Array.isArray(part.content) ? part.content.map(c => c.text || '').join('')
                : '';

              // Parse agentId from tool_result content
              // Format: "Async agent launched successfully.\nagentId: <id>\n..."
              const agentIdMatch = rawContent.match(/agentId:\s*(\S+)/);
              if (agentIdMatch && task.input?.run_in_background) {
                const agentId = agentIdMatch[1];
                // Start monitoring the subagent's transcript file
                // DO NOT mark as completed here - wait for monitor to detect completion
                monitorSubagentCompletion(agentId, toolUseId, ws);

                // Mark as monitoring, not completed
                task.status = 'monitoring';
                return; // Don't send completion message yet
              }

              // Only mark as completed if it's not a background subagent
              task.status = 'completed';
              task.endTime = Date.now();
              evictOldestCompletedTasks();

              ws.send({
                type: 'background-task-completed',
                sessionId: task.sessionId,
                taskId: toolUseId
              });

              // Background task completed
            }
          }
        });
      }

      // Extract and send token budget updates from result messages
      if (message.type === 'result') {
        // Finalize streaming message when result is received
        finalizeStreamingMessage(capturedSessionId || sessionId);

        const tokenBudget = extractTokenBudget(message);
        if (tokenBudget) {
          console.log('Token budget from modelUsage:', tokenBudget);
          ws.send({
            type: 'token-budget',
            data: tokenBudget,
            sessionId: capturedSessionId || sessionId || null
          });
        }
        // SDK bug workaround: generator may hang after result message.
        // Break out of the loop to prevent infinite blocking.
        break;
      }
    }

    // Clean up session on completion
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Clean up temporary image files
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Restore any task output files the CLI deleted on exit
    await restoreTaskOutputFiles();

    // Send completion event
    console.log('Streaming complete, sending claude-complete event');
    ws.send({
      type: 'claude-complete',
      sessionId: capturedSessionId,
      exitCode: 0,
      isNewSession: !sessionId && !!command
    });
    console.log('claude-complete event sent');

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Clean up temporary image files on error
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Restore any task output files the CLI deleted on exit
    await restoreTaskOutputFiles();

    // Send error to WebSocket
    ws.send({
      type: 'claude-error',
      error: error.message,
      sessionId: capturedSessionId || sessionId || null
    });

    throw error;
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up temporary image files
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending permission requests for a specific session (read-only query).
 * Returns an array of approval metadata without exposing internal resolve functions.
 * @param {string} sessionId - The session ID to query
 * @returns {Array} Array of pending approval metadata
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, approval] of pendingToolApprovals.entries()) {
    if (approval.sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: approval.toolName,
        input: approval.input,
        context: approval.context,
        sessionId: approval.sessionId,
        createdAt: approval.createdAt
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  backgroundTasks,
  backgroundTaskOutputs
};
