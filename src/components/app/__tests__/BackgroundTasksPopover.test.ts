// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for BackgroundTasksPopover event handling and reconnect logic.
 * These test the core logic (event dispatch, deduplication, state merging)
 * without mounting the full React component.
 */

type BackgroundTask = {
  taskId: string;
  toolName: string;
  input: any;
  sessionId: string | null;
  startTime: number;
  status: 'running' | 'monitoring' | 'completed' | 'terminating';
  endTime?: number;
  agentId?: string;
  progress?: Array<{ type: string; tool?: string; input?: any; text?: string }>;
  result?: string;
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

describe('BackgroundTasksPopover event handling', () => {
  // Replicate the handleTaskEvent logic from the component
  function createEventHandler(currentSessionId: string | null = null) {
    let tasks: BackgroundTask[] = [];
    let bashTasks: BashTask[] = [];
    const seenEvents = new Set<string>();

    const handleTaskEvent = (msg: any) => {
      // Filter by sessionId: with broadcast-to-all delivery, we receive events
      // for ALL sessions. Only process events for our current session.
      if (currentSessionId && msg.sessionId && msg.sessionId !== currentSessionId) {
        return;
      }

      // Deduplication
      if (msg.eventId) {
        if (seenEvents.has(msg.eventId)) return;
        seenEvents.add(msg.eventId);
      }

      if (msg.type === 'background-task-started') {
        tasks = [...tasks, msg.task];
      }

      if (msg.type === 'background-task-completed') {
        tasks = tasks.map(task =>
          task.taskId === msg.taskId
            ? { ...task, status: 'completed' as const, endTime: Date.now() }
            : task
        );
      }

      if (msg.type === 'subagent-progress') {
        tasks = tasks.map(task =>
          task.taskId === msg.taskId
            ? {
                ...task,
                agentId: msg.agentId || task.agentId,
                progress: [...(task.progress || []), ...msg.messages]
              }
            : task
        );
      }

      if (msg.type === 'subagent-completed') {
        tasks = tasks.map(task =>
          task.taskId === msg.taskId
            ? {
                ...task,
                agentId: msg.agentId || task.agentId,
                status: 'completed' as const,
                endTime: Date.now(),
                result: msg.output
              }
            : task
        );
      }

      if (msg.type === 'bash-started') {
        bashTasks = [...bashTasks, {
          ...msg.bash,
          sessionId: msg.sessionId || null,
          status: 'running' as const,
        }];
      }

      if (msg.type === 'bash-completed') {
        bashTasks = bashTasks.map(bash =>
          bash.id === msg.bash?.id
            ? { ...bash, status: 'completed' as const, endTime: msg.bash.endTime }
            : bash
        );
      }
    };

    return {
      handleTaskEvent,
      getTasks: () => tasks,
      getBashTasks: () => bashTasks,
      getSeenEvents: () => seenEvents
    };
  }

  describe('event dispatch', () => {
    it('should add task on background-task-started', () => {
      const h = createEventHandler();
      h.handleTaskEvent({
        type: 'background-task-started',
        task: { taskId: 't1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 's1', input: {} }
      });

      expect(h.getTasks()).toHaveLength(1);
      expect(h.getTasks()[0].taskId).toBe('t1');
    });

    it('should update task status on background-task-completed', () => {
      const h = createEventHandler();
      h.handleTaskEvent({
        type: 'background-task-started',
        task: { taskId: 't2', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 's1', input: {} }
      });
      h.handleTaskEvent({
        type: 'background-task-completed',
        taskId: 't2'
      });

      expect(h.getTasks()[0].status).toBe('completed');
      expect(h.getTasks()[0].endTime).toBeDefined();
    });

    it('should add bash task on bash-started', () => {
      const h = createEventHandler();
      h.handleTaskEvent({
        type: 'bash-started',
        sessionId: 's1',
        bash: { id: 'b1', command: 'npm test', run_in_background: true, startTime: 1000 }
      });

      expect(h.getBashTasks()).toHaveLength(1);
      expect(h.getBashTasks()[0].id).toBe('b1');
      expect(h.getBashTasks()[0].status).toBe('running');
    });

    it('should update bash task on bash-completed using msg.bash.id', () => {
      const h = createEventHandler();
      h.handleTaskEvent({
        type: 'bash-started',
        sessionId: 's1',
        bash: { id: 'b2', command: 'npm build', run_in_background: true, startTime: 1000 }
      });
      h.handleTaskEvent({
        type: 'bash-completed',
        bash: { id: 'b2', endTime: 2000 }
      });

      expect(h.getBashTasks()[0].status).toBe('completed');
      expect(h.getBashTasks()[0].endTime).toBe(2000);
    });

    it('should NOT update bash task when bash-completed has wrong id (msg.bashId regression)', () => {
      const h = createEventHandler();
      h.handleTaskEvent({
        type: 'bash-started',
        sessionId: 's1',
        bash: { id: 'b3', command: 'test', run_in_background: true, startTime: 1000 }
      });

      // This is the OLD buggy format (msg.bashId instead of msg.bash.id)
      h.handleTaskEvent({
        type: 'bash-completed',
        bashId: 'b3',  // WRONG field!
        // No msg.bash — should NOT update
      });

      // Task should remain running because the handler uses msg.bash?.id
      expect(h.getBashTasks()[0].status).toBe('running');
    });

    it('should accumulate subagent progress messages', () => {
      const h = createEventHandler();
      h.handleTaskEvent({
        type: 'background-task-started',
        task: { taskId: 'sp1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 's1', input: {} }
      });

      h.handleTaskEvent({
        type: 'subagent-progress',
        taskId: 'sp1',
        agentId: 'agent-xyz',
        messages: [{ type: 'tool_use', tool: 'Read', input: { file: 'a.ts' } }]
      });

      h.handleTaskEvent({
        type: 'subagent-progress',
        taskId: 'sp1',
        messages: [{ type: 'text', text: 'Found the bug' }]
      });

      const task = h.getTasks()[0];
      expect(task.agentId).toBe('agent-xyz');
      expect(task.progress).toHaveLength(2);
      expect(task.progress![0].tool).toBe('Read');
      expect(task.progress![1].text).toBe('Found the bug');
    });

    it('should mark task completed with result on subagent-completed', () => {
      const h = createEventHandler();
      h.handleTaskEvent({
        type: 'background-task-started',
        task: { taskId: 'sc1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 's1', input: {} }
      });

      h.handleTaskEvent({
        type: 'subagent-completed',
        taskId: 'sc1',
        agentId: 'agent-final',
        output: 'The analysis is complete.'
      });

      const task = h.getTasks()[0];
      expect(task.status).toBe('completed');
      expect(task.agentId).toBe('agent-final');
      expect(task.result).toBe('The analysis is complete.');
    });
  });

  describe('deduplication', () => {
    it('should deduplicate events with the same eventId', () => {
      const h = createEventHandler();

      const event = {
        type: 'background-task-started',
        eventId: 'evt-dup-1',
        task: { taskId: 'dup1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 's1', input: {} }
      };

      h.handleTaskEvent(event);
      h.handleTaskEvent(event);
      h.handleTaskEvent(event);

      // Should only be added once
      expect(h.getTasks()).toHaveLength(1);
    });

    it('should process events without eventId (no dedup)', () => {
      const h = createEventHandler();

      h.handleTaskEvent({
        type: 'background-task-started',
        task: { taskId: 'no-eid-1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 's1', input: {} }
      });
      h.handleTaskEvent({
        type: 'background-task-started',
        task: { taskId: 'no-eid-2', toolName: 'Task', status: 'running', startTime: 2000, sessionId: 's1', input: {} }
      });

      expect(h.getTasks()).toHaveLength(2);
    });
  });

  describe('Socket.IO type injection', () => {
    it('should work when type is injected from Socket.IO event name', () => {
      const h = createEventHandler();

      // Socket.IO strips 'type' from payload — frontend re-injects it
      // This is what the wrappedHandler does: { type: event, ...data }
      const socketPayload = {
        task: { taskId: 'injected-1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 's1', input: {} },
        sessionId: 's1',
        eventId: 'evt-inj-1'
      };

      // Simulate the wrapper: handler = (data) => handleTaskEvent({ type: event, ...data })
      h.handleTaskEvent({ type: 'background-task-started', ...socketPayload });

      expect(h.getTasks()).toHaveLength(1);
      expect(h.getTasks()[0].taskId).toBe('injected-1');
    });
  });

  describe('sessionId filtering (broadcast-to-all)', () => {
    it('should REJECT events from a different session when currentSessionId is set', () => {
      const h = createEventHandler('session-A');

      h.handleTaskEvent({
        type: 'background-task-started',
        sessionId: 'session-B',  // Different session!
        task: { taskId: 'foreign-1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 'session-B', input: {} }
      });

      expect(h.getTasks()).toHaveLength(0);
    });

    it('should ACCEPT events matching the current session', () => {
      const h = createEventHandler('session-A');

      h.handleTaskEvent({
        type: 'background-task-started',
        sessionId: 'session-A',
        task: { taskId: 'own-1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 'session-A', input: {} }
      });

      expect(h.getTasks()).toHaveLength(1);
      expect(h.getTasks()[0].taskId).toBe('own-1');
    });

    it('should ACCEPT events without sessionId (legacy compatibility)', () => {
      const h = createEventHandler('session-A');

      h.handleTaskEvent({
        type: 'background-task-started',
        // No sessionId in the event
        task: { taskId: 'legacy-1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: null, input: {} }
      });

      expect(h.getTasks()).toHaveLength(1);
    });

    it('should ACCEPT all events when currentSessionId is null', () => {
      const h = createEventHandler(null);

      h.handleTaskEvent({
        type: 'background-task-started',
        sessionId: 'any-session',
        task: { taskId: 'any-1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 'any-session', input: {} }
      });

      expect(h.getTasks()).toHaveLength(1);
    });

    it('should REJECT bash events from different sessions', () => {
      const h = createEventHandler('session-A');

      h.handleTaskEvent({
        type: 'bash-started',
        sessionId: 'session-B',
        bash: { id: 'b-foreign', command: 'npm test', run_in_background: true, startTime: 1000 }
      });

      expect(h.getBashTasks()).toHaveLength(0);
    });

    it('should REJECT subagent-progress from different sessions', () => {
      const h = createEventHandler('session-A');

      // First add a task for session-A
      h.handleTaskEvent({
        type: 'background-task-started',
        sessionId: 'session-A',
        task: { taskId: 'sp-filter', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 'session-A', input: {} }
      });

      // Then receive progress from a different session
      h.handleTaskEvent({
        type: 'subagent-progress',
        sessionId: 'session-B',
        taskId: 'sp-filter',
        messages: [{ type: 'text', text: 'should not appear' }]
      });

      // Progress should NOT be added
      expect(h.getTasks()[0].progress).toBeUndefined();
    });

    it('should REJECT subagent-completed from different sessions', () => {
      const h = createEventHandler('session-A');

      h.handleTaskEvent({
        type: 'background-task-started',
        sessionId: 'session-A',
        task: { taskId: 'sc-filter', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 'session-A', input: {} }
      });

      h.handleTaskEvent({
        type: 'subagent-completed',
        sessionId: 'session-B',
        taskId: 'sc-filter',
        agentId: 'agent-foreign',
        output: 'should not appear'
      });

      // Task should remain running
      expect(h.getTasks()[0].status).toBe('running');
      expect(h.getTasks()[0].result).toBeUndefined();
    });

    it('sessionId filtering happens BEFORE deduplication (no wasted eventIds)', () => {
      const h = createEventHandler('session-A');

      // Event from wrong session should be filtered BEFORE dedup check
      h.handleTaskEvent({
        type: 'background-task-started',
        sessionId: 'session-B',
        eventId: 'evt-filter-1',
        task: { taskId: 'filter-dedup', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 'session-B', input: {} }
      });

      // The eventId should NOT be in the seen set (filtered before dedup)
      expect(h.getSeenEvents().has('evt-filter-1')).toBe(false);
      expect(h.getTasks()).toHaveLength(0);
    });
  });

  describe('reconnect state merge (no sessionId → all tasks)', () => {
    // Simulate the mergeTasksFromServer helper used by the component.
    // On initial connect (before a session is selected), the component queries
    // with no sessionId, so the server returns ALL tasks across all sessions.
    function mergeTasksFromServer(
      existing: BackgroundTask[],
      serverTasks: BackgroundTask[]
    ): BackgroundTask[] {
      const existingIds = new Set(existing.map(t => t.taskId));
      const newTasks = serverTasks.filter(t => !existingIds.has(t.taskId));
      return newTasks.length ? [...existing, ...newTasks] : existing;
    }

    it('should merge tasks from multiple sessions when no sessionId filter', () => {
      const existing: BackgroundTask[] = [];
      const allServerTasks: BackgroundTask[] = [
        { taskId: 't-sA', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 'session-A', input: {} },
        { taskId: 't-sB', toolName: 'Task', status: 'completed', startTime: 2000, sessionId: 'session-B', input: {}, endTime: 3000 },
      ];

      const merged = mergeTasksFromServer(existing, allServerTasks);
      expect(merged).toHaveLength(2);
      expect(merged.map(t => t.sessionId)).toEqual(['session-A', 'session-B']);
    });

    it('sessionTasks filter shows only current session tasks from global list', () => {
      const allTasks: BackgroundTask[] = [
        { taskId: 't-sA', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 'session-A', input: {} },
        { taskId: 't-sB', toolName: 'Task', status: 'completed', startTime: 2000, sessionId: 'session-B', input: {}, endTime: 3000 },
        { taskId: 't-sA2', toolName: 'Task', status: 'running', startTime: 4000, sessionId: 'session-A', input: {} },
      ];

      // Replicate the component's display filter
      const currentSessionId = 'session-A';
      const sessionTasks = currentSessionId
        ? allTasks.filter(t => t.sessionId === currentSessionId)
        : allTasks;

      expect(sessionTasks).toHaveLength(2);
      expect(sessionTasks.every(t => t.sessionId === 'session-A')).toBe(true);
    });

    it('sessionTasks filter shows ALL tasks when no session selected', () => {
      const allTasks: BackgroundTask[] = [
        { taskId: 't-sA', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 'session-A', input: {} },
        { taskId: 't-sB', toolName: 'Task', status: 'completed', startTime: 2000, sessionId: 'session-B', input: {}, endTime: 3000 },
      ];

      const currentSessionId = null;
      const sessionTasks = currentSessionId
        ? allTasks.filter(t => t.sessionId === currentSessionId)
        : allTasks;

      expect(sessionTasks).toHaveLength(2);
    });
  });

  describe('reconnect state merge', () => {
    // Simulate the query-active-tasks response merge logic
    function mergeServerTasks(
      existing: BackgroundTask[],
      serverTasks: BackgroundTask[]
    ): BackgroundTask[] {
      const existingIds = new Set(existing.map(t => t.taskId));
      const newTasks = serverTasks.filter(t => !existingIds.has(t.taskId));
      return newTasks.length ? [...existing, ...newTasks] : existing;
    }

    function mergeServerBashTasks(
      existing: BashTask[],
      serverBash: BashTask[]
    ): BashTask[] {
      const existingIds = new Set(existing.map(b => b.id));
      const newBash = serverBash.filter(b => !existingIds.has(b.id));
      return newBash.length ? [...existing, ...newBash] : existing;
    }

    it('should add server tasks that are not in local state', () => {
      const local: BackgroundTask[] = [];
      const server: BackgroundTask[] = [
        { taskId: 'srv-1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 's1', input: {} },
        { taskId: 'srv-2', toolName: 'Task', status: 'completed', startTime: 2000, sessionId: 's1', input: {}, endTime: 3000 }
      ];

      const merged = mergeServerTasks(local, server);
      expect(merged).toHaveLength(2);
      expect(merged[0].taskId).toBe('srv-1');
      expect(merged[1].taskId).toBe('srv-2');
    });

    it('should not duplicate tasks already in local state', () => {
      const local: BackgroundTask[] = [
        { taskId: 'dup-1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 's1', input: {} }
      ];
      const server: BackgroundTask[] = [
        { taskId: 'dup-1', toolName: 'Task', status: 'completed', startTime: 1000, sessionId: 's1', input: {}, endTime: 2000 },
        { taskId: 'new-1', toolName: 'Task', status: 'running', startTime: 3000, sessionId: 's1', input: {} }
      ];

      const merged = mergeServerTasks(local, server);
      expect(merged).toHaveLength(2);
      // Original local task is preserved (not overwritten by server version)
      expect(merged[0].taskId).toBe('dup-1');
      expect(merged[0].status).toBe('running'); // local version
      expect(merged[1].taskId).toBe('new-1');
    });

    it('should merge bash tasks without duplicates', () => {
      const local: BashTask[] = [
        { id: 'b-existing', command: 'npm test', run_in_background: true, startTime: 1000, status: 'running' }
      ];
      const server: BashTask[] = [
        { id: 'b-existing', command: 'npm test', run_in_background: true, startTime: 1000, status: 'completed', endTime: 2000 },
        { id: 'b-new', command: 'npm build', run_in_background: true, startTime: 3000, status: 'running' }
      ];

      const merged = mergeServerBashTasks(local, server);
      expect(merged).toHaveLength(2);
      expect(merged[0].id).toBe('b-existing');
      expect(merged[0].status).toBe('running'); // local preserved
      expect(merged[1].id).toBe('b-new');
    });

    it('should return same reference when no new tasks to add', () => {
      const local: BackgroundTask[] = [
        { taskId: 'only-1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 's1', input: {} }
      ];
      const server: BackgroundTask[] = [
        { taskId: 'only-1', toolName: 'Task', status: 'running', startTime: 1000, sessionId: 's1', input: {} }
      ];

      const merged = mergeServerTasks(local, server);
      // Should return the same array (no new items to add)
      expect(merged).toBe(local);
    });
  });
});
