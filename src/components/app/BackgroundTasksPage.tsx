import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSocketIO } from '../../contexts/SocketIOContext';

type BackgroundTask = {
  taskId: string;
  toolName: string;
  input: any;
  sessionId: string | null;
  startTime: number;
  status: 'running' | 'completed' | 'terminating';
  endTime?: number;
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

export default function BackgroundTasksPage({ currentSessionId }: { currentSessionId?: string | null }) {
  const { t } = useTranslation('backgroundTasks');
  const [activeTab, setActiveTab] = useState<'subagents' | 'bash'>('subagents');
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [bashTasks, setBashTasks] = useState<BashTask[]>([]);
  const [taskOutputs, setTaskOutputs] = useState<Map<string, TaskOutput>>(new Map());
  const { emit, socket } = useSocketIO();

  const isMobile = useMemo(() => window.innerWidth < 768, []);
  const maxLines = useMemo(() => isMobile ? 50 : 200, [isMobile]);

  // Poll task output every 5 seconds for running tasks
  useEffect(() => {
    const runningIds = [
      ...tasks.filter(t => t.status === 'running').map(t => t.taskId),
      ...bashTasks.filter(b => b.run_in_background && b.status === 'running').map(b => b.id),
    ];

    if (runningIds.length === 0) return;

    // Query immediately
    runningIds.forEach(id => {
      emit('query-task-output', { taskId: id, maxLines });
    });

    const interval = setInterval(() => {
      runningIds.forEach(id => {
        emit('query-task-output', { taskId: id, maxLines });
      });
    }, 5000);

    return () => clearInterval(interval);
  }, [tasks, bashTasks, emit, maxLines]);

  // Listen for task events
  useEffect(() => {
    if (!socket) return;

    const handleTaskEvent = (msg: any) => {
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

      if (msg.type === 'bash-started' && msg.bash.run_in_background) {
        setBashTasks(prev => [...prev, { ...msg.bash, status: 'running' as const }]);
      }

      if (msg.type === 'bash-completed') {
        setBashTasks(prev =>
          prev.map(bash =>
            bash.id === msg.bashId
              ? { ...bash, status: 'completed' as const, endTime: Date.now() }
              : bash
          )
        );
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
    };

    // Register event listeners for background task events
    const events = [
      'background-task-started',
      'background-task-completed',
      'background-task-deleted',
      'task-output',
      'task-killed'
    ];

    events.forEach(event => {
      socket.on(event, handleTaskEvent);
    });

    return () => {
      events.forEach(event => {
        socket.off(event, handleTaskEvent);
      });
    };
  }, [socket]);

  const handleDeleteTask = (taskId: string, status: string) => {
    if (status === 'running') {
      emit('kill-task', { taskId });
      setTasks(prev =>
        prev.map(task =>
          task.taskId === taskId ? { ...task, status: 'terminating' as const } : task
        )
      );
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
      emit('kill-task', { taskId: bashId });
      setBashTasks(prev =>
        prev.map(bash => (bash.id === bashId ? { ...bash, status: 'terminating' as const } : bash))
      );
    } else {
      setBashTasks(prev => prev.filter(b => b.id !== bashId));
      setTaskOutputs(prev => {
        const next = new Map(prev);
        next.delete(bashId);
        return next;
      });
    }
  };

  const sessionTasks = tasks.filter(t => !currentSessionId || t.sessionId === currentSessionId);
  const sessionBashTasks = bashTasks.filter(
    b => !currentSessionId || b.sessionId === currentSessionId
  );

  const runningTasks = sessionTasks.filter(t => t.status === 'running');
  const runningBashTasks = sessionBashTasks.filter(b => b.status === 'running');

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('subagents')}
          className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === 'subagents'
              ? 'bg-accent text-accent-foreground border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t('tabs.subagents')} ({runningTasks.length})
        </button>
        <button
          onClick={() => setActiveTab('bash')}
          className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === 'bash'
              ? 'bg-accent text-accent-foreground border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t('tabs.bash')} ({runningBashTasks.length})
        </button>
      </div>

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
                <BashItem
                  key={bash.id}
                  bash={bash}
                  output={taskOutputs.get(bash.id)}
                  onDelete={handleDeleteBash}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskItem({
  task,
  output,
  onDelete,
}: {
  task: BackgroundTask;
  output?: TaskOutput;
  onDelete: (taskId: string, status: string) => void;
}) {
  const { t } = useTranslation('backgroundTasks');
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border rounded-md p-3 bg-card">
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{task.toolName}</span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${
                task.status === 'running'
                  ? 'bg-blue-500/10 text-blue-500'
                  : task.status === 'terminating'
                  ? 'bg-yellow-500/10 text-yellow-500'
                  : 'bg-green-500/10 text-green-500'
              }`}
            >
              {t(`status.${task.status}`)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">{t('taskId.label')}: {task.taskId}</p>
        </div>
        <button
          onClick={() => onDelete(task.taskId, task.status)}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title={task.status === 'running' ? t('actions.dismiss') : t('actions.remove')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {output && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <svg
              className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            {t('output.label')}
          </button>
          {expanded && (
            <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-x-auto max-h-64 overflow-y-auto">
              {output.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function BashItem({
  bash,
  output,
  onDelete,
}: {
  bash: BashTask;
  output?: TaskOutput;
  onDelete: (bashId: string, status?: string) => void;
}) {
  const { t } = useTranslation('backgroundTasks');
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border rounded-md p-3 bg-card">
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <code className="text-xs bg-muted px-2 py-1 rounded">{bash.command}</code>
            {bash.status && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  bash.status === 'running'
                    ? 'bg-blue-500/10 text-blue-500'
                    : bash.status === 'terminating'
                    ? 'bg-yellow-500/10 text-yellow-500'
                    : 'bg-green-500/10 text-green-500'
                }`}
              >
                {t(`status.${bash.status}`)}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{t('taskId.label')}: {bash.id}</p>
        </div>
        <button
          onClick={() => onDelete(bash.id, bash.status)}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title={bash.status === 'running' ? t('actions.dismissBash') : t('actions.remove')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {output && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <svg
              className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            {t('output.label')}
          </button>
          {expanded && (
            <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-x-auto max-h-64 overflow-y-auto">
              {output.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
