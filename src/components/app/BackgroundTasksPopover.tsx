import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWebSocket } from '../../contexts/WebSocketContext';

type BackgroundTask = {
  taskId: string;
  toolName: string;
  input: any;
  sessionId: string | null;
  startTime: number;
  status: 'running' | 'monitoring' | 'completed' | 'terminating';
  endTime?: number;
  agentId?: string;
  progress?: ProgressMessage[];
  result?: string;
};

type ProgressMessage = {
  type: 'tool_use' | 'text';
  tool?: string;
  input?: any;
  text?: string;
};

type BashTask = {
  id: string;
  command: string;
  description?: string;
  run_in_background: boolean;
  startTime: number;
  sessionId?: string | null;
  status?: 'running' | 'completed' | 'terminating';
  endTime?: number;
};

type TaskOutput = {
  content: string;
  truncated: boolean;
  totalLines: number;
  skippedLines?: number;
};

export default function BackgroundTasksPopover({ currentSessionId }: { currentSessionId?: string | null }) {
  const { t } = useTranslation('backgroundTasks');
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'subagents' | 'bash'>('subagents');
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [bashTasks, setBashTasks] = useState<BashTask[]>([]);
  const [taskOutputs, setTaskOutputs] = useState<Map<string, TaskOutput>>(new Map());
  const { sendMessage, subscribe, isConnected } = useWebSocket();

  // On WebSocket (re)connect, request all un-ACK'd events for this session
  const prevConnectedRef = useRef(false);
  useEffect(() => {
    if (isConnected && !prevConnectedRef.current && currentSessionId) {
      sendMessage({ type: 'sync-background-events', sessionId: currentSessionId });
    }
    prevConnectedRef.current = isConnected;
  }, [isConnected, currentSessionId, sendMessage]);

  const isMobile = useMemo(() => window.innerWidth < 768, []);
  const maxLines = useMemo(() => isMobile ? 50 : 200, [isMobile]);

  // Poll task output every 5 seconds for running tasks (only when drawer is open)
  useEffect(() => {
    if (!isOpen) return;

    const runningIds = [
      ...tasks.filter(t => t.status === 'running').map(t => t.taskId),
      ...bashTasks.filter(b => b.run_in_background && b.status === 'running').map(b => b.id),
    ];

    if (runningIds.length === 0) return;

    runningIds.forEach(id => {
      sendMessage({ type: 'query-task-output', taskId: id, maxLines });
    });

    const interval = setInterval(() => {
      runningIds.forEach(id => {
        sendMessage({ type: 'query-task-output', taskId: id, maxLines });
      });
    }, 5000);

    return () => clearInterval(interval);
  }, [tasks, bashTasks, sendMessage, maxLines, isOpen]);

  // Deduplication set for at-least-once delivered events
  const seenEventsRef = useRef(new Set<string>());

  // Listen for task events - ALWAYS subscribed (not conditional on isOpen)
  useEffect(() => {
    return subscribe((msg: any) => {
      // At-least-once: ACK receipt and deduplicate
      if (msg.eventId) {
        sendMessage({ type: 'ack-event', eventId: msg.eventId, sessionId: msg.sessionId });
        if (seenEventsRef.current.has(msg.eventId)) return; // already processed
        seenEventsRef.current.add(msg.eventId);
        // Cap the set to prevent unbounded growth
        if (seenEventsRef.current.size > 500) {
          const iter = seenEventsRef.current.values();
          for (let i = 0; i < 100; i++) iter.next();
          // Delete oldest 100 entries
          const toKeep = new Set<string>();
          for (const v of iter) toKeep.add(v);
          seenEventsRef.current = toKeep;
        }
      }

      if (msg.type === 'background-task-started') {
        setTasks(prev => [...prev, msg.task]);
      }

      if (msg.type === 'background-task-completed') {
        setTasks(prev =>
          prev.map(task =>
            task.taskId === msg.taskId
              ? { ...task, status: 'completed' as const, endTime: Date.now() }
              : task
          )
        );
      }

      // Subagent progress: tool calls and text from transcript
      if (msg.type === 'subagent-progress') {
        setTasks(prev =>
          prev.map(task =>
            task.taskId === msg.taskId
              ? {
                  ...task,
                  agentId: msg.agentId || task.agentId,
                  progress: [...(task.progress || []), ...msg.messages]
                }
              : task
          )
        );
      }

      // Subagent completed: final result from output file
      if (msg.type === 'subagent-completed') {
        setTasks(prev =>
          prev.map(task =>
            task.taskId === msg.taskId
              ? {
                  ...task,
                  agentId: msg.agentId || task.agentId,
                  status: 'completed' as const,
                  endTime: Date.now(),
                  result: msg.output
                }
              : task
          )
        );
      }

      if (msg.type === 'bash-started') {
        setBashTasks(prev => [
          ...prev,
          {
            ...msg.bash,
            sessionId: msg.sessionId || null,
            status: 'running' as const,
          }
        ]);
      }

      if (msg.type === 'bash-completed') {
        setBashTasks(prev =>
          prev.map(bash =>
            bash.id === msg.bash?.id
              ? { ...bash, status: 'completed' as const, endTime: msg.bash.endTime }
              : bash
          )
        );
        // Fetch final output once on completion
        if (msg.bash?.id) {
          sendMessage({ type: 'query-task-output', taskId: msg.bash.id, maxLines });
        }
      }

      if (msg.type === 'task-output') {
        setTaskOutputs(prev => {
          const next = new Map(prev);
          next.set(msg.taskId, msg.output);
          return next;
        });
      }

      if (msg.type === 'task-killed') {
        if (msg.success) {
          setTasks(prev =>
            prev.map(task =>
              task.taskId === msg.taskId
                ? { ...task, status: 'completed' as const, endTime: Date.now() }
                : task
            )
          );
          setBashTasks(prev =>
            prev.map(bash =>
              bash.id === msg.taskId
                ? { ...bash, status: 'completed' as const, endTime: Date.now() }
                : bash
            )
          );
        }
      }
    });
  }, [subscribe]);

  const sessionTasks = currentSessionId
    ? tasks.filter(t => t.sessionId === currentSessionId)
    : tasks;
  const sessionBashTasks = currentSessionId
    ? bashTasks.filter(b => b.sessionId === currentSessionId)
    : bashTasks;

  const activeTasks = sessionTasks.filter(t => t.status === 'running' || t.status === 'monitoring');
  const runningBashTasks = sessionBashTasks.filter(b => b.run_in_background && b.status === 'running');

  const handleDeleteTask = (taskId: string, status: string) => {
    if (status === 'running' || status === 'monitoring') {
      sendMessage({ type: 'kill-task', taskId });
      setTasks(prev => prev.map(task =>
        task.taskId === taskId
          ? { ...task, status: 'terminating' as const }
          : task
      ));
    } else {
      setTasks(prev => prev.filter(t => t.taskId !== taskId));
      setTaskOutputs(prev => {
        const next = new Map(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  const handleDeleteBash = (bashId: string, status?: string) => {
    if (status === 'running') {
      sendMessage({ type: 'kill-task', taskId: bashId });
      setBashTasks(prev => prev.map(bash =>
        bash.id === bashId
          ? { ...bash, status: 'terminating' as const }
          : bash
      ));
    } else {
      setBashTasks(prev => prev.filter(b => b.id !== bashId));
      setTaskOutputs(prev => {
        const next = new Map(prev);
        next.delete(bashId);
        return next;
      });
    }
  };

  // Auto-evict old completed tasks
  useEffect(() => {
    const TASKS_MAX = 200;
    if (tasks.length > TASKS_MAX) {
      setTasks(prev => {
        const completed = prev.filter(t => t.status === 'completed').sort((a, b) => (a.endTime || 0) - (b.endTime || 0));
        const running = prev.filter(t => t.status !== 'completed');
        const toEvict = Math.max(0, prev.length - TASKS_MAX);
        return [...running, ...completed.slice(toEvict)];
      });
    }

    const BASH_TASKS_MAX = 200;
    if (bashTasks.length > BASH_TASKS_MAX) {
      setBashTasks(prev => {
        const completed = prev.filter(b => b.status === 'completed').sort((a, b) => (a.endTime || 0) - (b.endTime || 0));
        const running = prev.filter(b => b.status === 'running');
        const toEvict = Math.max(0, prev.length - BASH_TASKS_MAX);
        return [...running, ...completed.slice(toEvict)];
      });
    }
  }, [tasks.length, bashTasks.length]);

  return (
    <>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 hover:bg-accent rounded-md transition-colors"
        title={t('title')}
      >
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
          />
        </svg>
        {(activeTasks.length > 0 || runningBashTasks.length > 0) && (
          <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
            {activeTasks.length + runningBashTasks.length}
          </span>
        )}
      </button>

      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Drawer - Always mounted, slides in/out */}
      <div
        className={`fixed top-0 right-0 h-full w-96 bg-card border-l border-border shadow-2xl z-50 transform transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-border">
            <h2 className="text-lg font-semibold">{t('title')}</h2>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1 hover:bg-accent rounded transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border">
            <button
              onClick={() => setActiveTab('subagents')}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === 'subagents'
                  ? 'bg-accent text-accent-foreground border-b-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('tabs.subagents')} ({sessionTasks.length})
            </button>
            <button
              onClick={() => setActiveTab('bash')}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === 'bash'
                  ? 'bg-accent text-accent-foreground border-b-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('tabs.bash')} ({sessionBashTasks.length})
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
            {activeTab === 'subagents' && (
              <div className="space-y-3">
                {sessionTasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    {t('empty.subagents')}
                  </p>
                ) : (
                  sessionTasks.map(task => (
                    <TaskItem
                      key={task.taskId}
                      task={task}
                      output={taskOutputs.get(task.taskId)}
                      onDelete={handleDeleteTask}
                    />
                  ))
                )}
              </div>
            )}

            {activeTab === 'bash' && (
              <div className="space-y-3">
                {sessionBashTasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    {t('empty.bash')}
                  </p>
                ) : (
                  sessionBashTasks.map(bash => (
                    <BashItem key={bash.id} bash={bash} output={taskOutputs.get(bash.id)} onDelete={handleDeleteBash} />
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** Extract a short description from Task tool input */
function getTaskDescription(input: any): string {
  if (!input) return '';
  // Task tool has description, prompt fields
  if (input.description) return input.description;
  if (input.prompt) {
    const prompt = String(input.prompt);
    return prompt.length > 120 ? prompt.slice(0, 120) + '...' : prompt;
  }
  return '';
}

/** Extract a concise display string from a tool's input */
function getToolInputSummary(tool?: string, input?: any): string {
  if (!tool || !input) return '';
  switch (tool) {
    case 'Bash':
      return String(input.command || '').slice(0, 60);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'ApplyPatch':
      return input.file_path || '';
    case 'Grep':
    case 'Glob':
      return input.pattern || '';
    case 'Task':
      return input.description || input.subagent_type || '';
    case 'WebFetch':
      return input.url || '';
    case 'WebSearch':
      return input.query || '';
    default:
      return '';
  }
}

function TaskItem({ task, output, onDelete }: { task: BackgroundTask; output?: TaskOutput; onDelete: (taskId: string, status: string) => void }) {
  const { t } = useTranslation('backgroundTasks');
  const [expanded, setExpanded] = useState(false);

  const description = getTaskDescription(task.input);
  const displayId = task.agentId || task.taskId.slice(-8);
  const isActive = task.status === 'running' || task.status === 'monitoring';

  const statusColor = isActive
    ? 'bg-blue-500/10 text-blue-500'
    : task.status === 'terminating'
    ? 'bg-yellow-500/10 text-yellow-500'
    : 'bg-green-500/10 text-green-500';

  const statusLabel = task.status === 'monitoring' ? t('status.running') : t(`status.${task.status}`);

  return (
    <div className="border border-border rounded-md p-3 bg-background">
      <div className="flex items-start justify-between mb-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground">{displayId}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor}`}>
              {statusLabel}
            </span>
            {isActive && (
              <span className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            )}
          </div>
        </div>
        <button
          onClick={() => onDelete(task.taskId, task.status)}
          className="p-1 hover:bg-destructive/10 hover:text-destructive rounded transition-colors flex-shrink-0"
          title={isActive ? t('actions.dismiss') : t('actions.remove')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Description */}
      {description && (
        <p className="text-sm text-foreground mt-1 break-words">{description}</p>
      )}

      <p className="text-xs text-muted-foreground mt-1">
        {new Date(task.startTime).toLocaleTimeString()}
        {task.endTime && ` — ${new Date(task.endTime).toLocaleTimeString()}`}
        {task.endTime && ` (${Math.round((task.endTime - task.startTime) / 1000)}s)`}
      </p>

      {/* Progress: tool calls */}
      {task.progress && task.progress.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <svg
              className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            {t('progress.toolCalls', { count: task.progress.filter(p => p.type === 'tool_use').length })}
          </button>
          {expanded && (
            <div className="mt-1 space-y-1 max-h-40 overflow-y-auto">
              {task.progress.map((p, i) => (
                <div key={i} className="text-xs">
                  {p.type === 'tool_use' ? (
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <span className="text-blue-400 font-mono">{p.tool}</span>
                      <span className="text-muted-foreground truncate">
                        {getToolInputSummary(p.tool, p.input)}
                      </span>
                    </div>
                  ) : (
                    <p className="text-muted-foreground truncate">{p.text}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Result */}
      {task.result && (
        <div className="mt-2">
          <pre className="text-xs bg-muted p-2 rounded overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
            {task.result}
          </pre>
        </div>
      )}

      {/* Legacy output from query-task-output */}
      {!task.result && output && (
        <div className="mt-2">
          <pre className="text-xs bg-muted p-2 rounded overflow-x-auto max-h-32 overflow-y-auto">
            {output.content}
          </pre>
          {output.truncated && (
            <p className="text-xs text-muted-foreground mt-1">
              {t('output.showing', {
                shown: output.totalLines - (output.skippedLines || 0),
                total: output.totalLines
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function BashItem({ bash, output, onDelete }: { bash: BashTask; output?: TaskOutput; onDelete: (bashId: string, status?: string) => void }) {
  const { t } = useTranslation('backgroundTasks');
  const status = bash.status || (bash.run_in_background ? 'running' : undefined);

  return (
    <div className="border border-border rounded-md p-3 bg-background">
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{t('tabs.bash')}</span>
            {status && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  status === 'running'
                    ? 'bg-blue-500/10 text-blue-500'
                    : status === 'terminating'
                    ? 'bg-yellow-500/10 text-yellow-500'
                    : 'bg-green-500/10 text-green-500'
                }`}
              >
                {t(`status.${status}`)}
              </span>
            )}
          </div>
          {bash.description && (
            <p className="text-xs text-muted-foreground mt-1">{bash.description}</p>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            {new Date(bash.startTime).toLocaleTimeString()}
          </p>
        </div>
        <button
          onClick={() => onDelete(bash.id, status)}
          className="p-1 hover:bg-destructive/10 hover:text-destructive rounded transition-colors flex-shrink-0"
          title={status === 'running' ? t('actions.dismissBash') : t('actions.remove')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="mt-2">
        <pre className="text-xs bg-muted p-2 rounded overflow-x-auto">
          {bash.command}
        </pre>
      </div>

      {output && output.content && (
        <div className="mt-2">
          <p className="text-xs text-muted-foreground mb-1">{t('output.label', 'Output')}:</p>
          <pre className="text-xs bg-muted p-2 rounded overflow-x-auto max-h-32 overflow-y-auto">
            {output.content}
          </pre>
          {output.truncated && (
            <p className="text-xs text-muted-foreground mt-1">
              {t('output.showing', {
                shown: output.totalLines - (output.skippedLines || 0),
                total: output.totalLines
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
