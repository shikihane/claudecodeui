// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for useProjectsState Socket.IO integration.
 * Validates the projects_updated and loading_progress event handlers
 * that were migrated from latestMessage-based to direct Socket.IO subscription.
 *
 * Key logic tested:
 * - projectsHaveChanges: detects whether projects list has meaningful changes
 * - isUpdateAdditive: determines if an update is safe to apply during active session
 * - handleProjectsUpdated: processes projects_updated events with session guards
 * - handleLoadingProgress: processes loading_progress events with timeout cleanup
 */

type Project = {
  name: string;
  displayName?: string;
  fullPath?: string;
  sessions?: Array<{ id: string; title?: string; created_at?: string; updated_at?: string; __provider?: string }>;
  codexSessions?: Array<{ id: string; title?: string; created_at?: string; updated_at?: string; __provider?: string }>;
  cursorSessions?: Array<{ id: string; title?: string; created_at?: string; updated_at?: string; __provider?: string }>;
  sessionMeta?: Record<string, unknown>;
};

type ProjectSession = {
  id: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  __provider?: string;
};

type LoadingProgress = {
  phase: string;
  current?: number;
  total?: number;
  message?: string;
};

// =========================================================================
// Replicates projectsHaveChanges from useProjectsState
// =========================================================================
const serialize = (value: unknown) => JSON.stringify(value ?? null);

const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
  includeExternalSessions: boolean,
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    const baseChanged =
      nextProject.name !== prevProject.name ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions);

    if (baseChanged) {
      return true;
    }

    if (!includeExternalSessions) {
      return false;
    }

    return (
      serialize(nextProject.cursorSessions) !== serialize(prevProject.cursorSessions) ||
      serialize(nextProject.codexSessions) !== serialize(prevProject.codexSessions)
    );
  });
};

// =========================================================================
// Replicates getProjectSessions from useProjectsState
// =========================================================================
const getProjectSessions = (project: Project): ProjectSession[] => {
  return [
    ...(project.sessions ?? []),
    ...(project.codexSessions ?? []),
    ...(project.cursorSessions ?? []),
  ];
};

// =========================================================================
// Replicates isUpdateAdditive from useProjectsState
// =========================================================================
const isUpdateAdditive = (
  currentProjects: Project[],
  updatedProjects: Project[],
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): boolean => {
  if (!selectedProject || !selectedSession) {
    return true;
  }

  const currentSelectedProject = currentProjects.find((p) => p.name === selectedProject.name);
  const updatedSelectedProject = updatedProjects.find((p) => p.name === selectedProject.name);

  if (!currentSelectedProject || !updatedSelectedProject) {
    return false;
  }

  const currentSelectedSession = getProjectSessions(currentSelectedProject).find(
    (s) => s.id === selectedSession.id,
  );
  const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
    (s) => s.id === selectedSession.id,
  );

  if (!currentSelectedSession || !updatedSelectedSession) {
    return false;
  }

  return (
    currentSelectedSession.id === updatedSelectedSession.id &&
    currentSelectedSession.title === updatedSelectedSession.title &&
    currentSelectedSession.created_at === updatedSelectedSession.created_at &&
    currentSelectedSession.updated_at === updatedSelectedSession.updated_at
  );
};

// =========================================================================
// Replicates handleProjectsUpdated logic from useProjectsState
// =========================================================================
function createProjectsHandler(initialState: {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeSessions: Set<string>;
}) {
  let projects = initialState.projects;
  let selectedProject = initialState.selectedProject;
  let selectedSession = initialState.selectedSession;
  const activeSessions = initialState.activeSessions;
  let externalMessageUpdate = 0;

  const handleProjectsUpdated = (data: any) => {
    const projectsMessage = data;

    if (projectsMessage.changedFile && selectedSession && selectedProject) {
      const normalized = projectsMessage.changedFile.replace(/\\/g, '/');
      const changedFileParts = normalized.split('/');

      if (changedFileParts.length >= 2) {
        const filename = changedFileParts[changedFileParts.length - 1];
        const changedSessionId = filename.replace('.jsonl', '');

        if (changedSessionId === selectedSession.id) {
          const isSessionActive = activeSessions.has(selectedSession.id);

          if (!isSessionActive) {
            externalMessageUpdate++;
          }
        }
      }
    }

    const hasActiveSession =
      (selectedSession && activeSessions.has(selectedSession.id)) ||
      (activeSessions.size > 0 && Array.from(activeSessions).some((id) => id.startsWith('new-session-')));

    const updatedProjects = projectsMessage.projects;

    if (
      hasActiveSession &&
      !isUpdateAdditive(projects, updatedProjects, selectedProject, selectedSession)
    ) {
      return;
    }

    projects = updatedProjects;

    if (!selectedProject) {
      return;
    }

    const updatedSelectedProject = updatedProjects.find(
      (project: Project) => project.name === selectedProject!.name,
    );

    if (!updatedSelectedProject) {
      return;
    }

    if (serialize(updatedSelectedProject) !== serialize(selectedProject)) {
      selectedProject = updatedSelectedProject;
    }

    if (!selectedSession) {
      return;
    }

    const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
      (session) => session.id === selectedSession!.id,
    );

    if (!updatedSelectedSession) {
      selectedSession = null;
    }
  };

  return {
    handleProjectsUpdated,
    getProjects: () => projects,
    getSelectedProject: () => selectedProject,
    getSelectedSession: () => selectedSession,
    getExternalMessageUpdate: () => externalMessageUpdate,
  };
}

// =========================================================================
// Replicates handleLoadingProgress logic from useProjectsState
// =========================================================================
function createLoadingProgressHandler() {
  let loadingProgress: LoadingProgress | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const handleLoadingProgress = (data: any) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    loadingProgress = data as LoadingProgress;

    if (data.phase === 'complete') {
      timeoutId = setTimeout(() => {
        loadingProgress = null;
        timeoutId = null;
      }, 500);
    }
  };

  return {
    handleLoadingProgress,
    getLoadingProgress: () => loadingProgress,
    getTimeoutId: () => timeoutId,
    cleanup: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
  };
}

// =========================================================================
// Tests
// =========================================================================

describe('useProjectsState logic', () => {
  // =========================================================================
  // projectsHaveChanges
  // =========================================================================
  describe('projectsHaveChanges', () => {
    it('should detect length changes', () => {
      const prev = [{ name: 'a' }];
      const next = [{ name: 'a' }, { name: 'b' }];
      expect(projectsHaveChanges(prev, next, false)).toBe(true);
    });

    it('should return false for identical projects', () => {
      const projects = [
        { name: 'a', displayName: 'A', fullPath: '/a', sessions: [{ id: 's1' }] },
      ];
      expect(projectsHaveChanges(projects, [...projects], false)).toBe(false);
    });

    it('should detect name changes', () => {
      const prev = [{ name: 'a' }];
      const next = [{ name: 'b' }];
      expect(projectsHaveChanges(prev, next, false)).toBe(true);
    });

    it('should detect session changes', () => {
      const prev = [{ name: 'a', sessions: [{ id: 's1' }] }];
      const next = [{ name: 'a', sessions: [{ id: 's1' }, { id: 's2' }] }];
      expect(projectsHaveChanges(prev, next, false)).toBe(true);
    });

    it('should detect cursor session changes when includeExternalSessions=true', () => {
      const prev = [{ name: 'a', cursorSessions: [{ id: 'c1' }] }];
      const next = [{ name: 'a', cursorSessions: [{ id: 'c1' }, { id: 'c2' }] }];
      expect(projectsHaveChanges(prev, next, false)).toBe(false);
      expect(projectsHaveChanges(prev, next, true)).toBe(true);
    });

    it('should detect codex session changes when includeExternalSessions=true', () => {
      const prev = [{ name: 'a', codexSessions: [] }];
      const next = [{ name: 'a', codexSessions: [{ id: 'x1' }] }];
      expect(projectsHaveChanges(prev, next, false)).toBe(false);
      expect(projectsHaveChanges(prev, next, true)).toBe(true);
    });
  });

  // =========================================================================
  // isUpdateAdditive
  // =========================================================================
  describe('isUpdateAdditive', () => {
    it('should return true when no selected project or session', () => {
      expect(isUpdateAdditive([], [], null, null)).toBe(true);
      expect(isUpdateAdditive([], [], { name: 'a' }, null)).toBe(true);
    });

    it('should return false when selected project disappears from update', () => {
      const current = [{ name: 'a', sessions: [{ id: 's1' }] }];
      const updated: Project[] = [];
      const result = isUpdateAdditive(current, updated, { name: 'a' }, { id: 's1' });
      expect(result).toBe(false);
    });

    it('should return false when selected session disappears', () => {
      const current = [{ name: 'a', sessions: [{ id: 's1' }, { id: 's2' }] }];
      const updated = [{ name: 'a', sessions: [{ id: 's2' }] }];
      const result = isUpdateAdditive(current, updated, { name: 'a' }, { id: 's1' });
      expect(result).toBe(false);
    });

    it('should return true when selected session unchanged', () => {
      const session = { id: 's1', title: 'Test', created_at: '2025-01-01', updated_at: '2025-01-01' };
      const current = [{ name: 'a', sessions: [session] }];
      const updated = [{ name: 'a', sessions: [session, { id: 's2' }] }];
      const result = isUpdateAdditive(current, updated, { name: 'a' }, session);
      expect(result).toBe(true);
    });

    it('should return false when selected session title changed', () => {
      const session = { id: 's1', title: 'Old', created_at: '2025-01-01', updated_at: '2025-01-01' };
      const current = [{ name: 'a', sessions: [session] }];
      const updated = [{ name: 'a', sessions: [{ ...session, title: 'New' }] }];
      const result = isUpdateAdditive(current, updated, { name: 'a' }, session);
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // handleProjectsUpdated
  // =========================================================================
  describe('handleProjectsUpdated', () => {
    it('should update projects list', () => {
      const h = createProjectsHandler({
        projects: [],
        selectedProject: null,
        selectedSession: null,
        activeSessions: new Set(),
      });

      h.handleProjectsUpdated({
        projects: [{ name: 'new-project', sessions: [] }],
      });

      expect(h.getProjects()).toHaveLength(1);
      expect(h.getProjects()[0].name).toBe('new-project');
    });

    it('should update selectedProject when project data changes', () => {
      const project = { name: 'a', displayName: 'A', sessions: [{ id: 's1' }] };
      const h = createProjectsHandler({
        projects: [project],
        selectedProject: project,
        selectedSession: null,
        activeSessions: new Set(),
      });

      const updatedProject = { name: 'a', displayName: 'A Updated', sessions: [{ id: 's1' }] };
      h.handleProjectsUpdated({ projects: [updatedProject] });

      expect(h.getSelectedProject()?.displayName).toBe('A Updated');
    });

    it('should clear selectedSession when session removed', () => {
      const session = { id: 's1', title: 'Test' };
      const project = { name: 'a', sessions: [session] };
      const h = createProjectsHandler({
        projects: [project],
        selectedProject: project,
        selectedSession: session,
        activeSessions: new Set(),
      });

      h.handleProjectsUpdated({
        projects: [{ name: 'a', sessions: [] }],
      });

      expect(h.getSelectedSession()).toBeNull();
    });

    it('should block non-additive updates during active session', () => {
      const session = { id: 's1', title: 'Original' };
      const project = { name: 'a', sessions: [session] };
      const h = createProjectsHandler({
        projects: [project],
        selectedProject: project,
        selectedSession: session,
        activeSessions: new Set(['s1']),
      });

      // This update changes the session title — non-additive for the selected session
      h.handleProjectsUpdated({
        projects: [{ name: 'a', sessions: [{ id: 's1', title: 'Changed' }] }],
      });

      // Projects should NOT be updated (blocked by active session guard)
      expect(h.getProjects()[0].sessions![0].title).toBe('Original');
    });

    it('should allow additive updates during active session', () => {
      const session = { id: 's1', title: 'Test', created_at: '2025-01-01', updated_at: '2025-01-01' };
      const project = { name: 'a', sessions: [session] };
      const h = createProjectsHandler({
        projects: [project],
        selectedProject: project,
        selectedSession: session,
        activeSessions: new Set(['s1']),
      });

      // This update adds a new session — additive, should be allowed
      h.handleProjectsUpdated({
        projects: [{ name: 'a', sessions: [session, { id: 's2', title: 'New' }] }],
      });

      expect(h.getProjects()[0].sessions).toHaveLength(2);
    });

    it('should increment externalMessageUpdate for changed file matching inactive session', () => {
      const session = { id: 'abc123', title: 'Test' };
      const project = { name: 'a', sessions: [session] };
      const h = createProjectsHandler({
        projects: [project],
        selectedProject: project,
        selectedSession: session,
        activeSessions: new Set(), // session NOT active
      });

      h.handleProjectsUpdated({
        projects: [project],
        changedFile: '/home/user/.claude/projects/a/abc123.jsonl',
      });

      expect(h.getExternalMessageUpdate()).toBe(1);
    });

    it('should NOT increment externalMessageUpdate when session is active', () => {
      const session = { id: 'abc123', title: 'Test' };
      const project = { name: 'a', sessions: [session] };
      const h = createProjectsHandler({
        projects: [project],
        selectedProject: project,
        selectedSession: session,
        activeSessions: new Set(['abc123']), // session IS active
      });

      h.handleProjectsUpdated({
        projects: [project],
        changedFile: '/home/user/.claude/projects/a/abc123.jsonl',
      });

      expect(h.getExternalMessageUpdate()).toBe(0);
    });

    it('should handle Windows backslash paths in changedFile', () => {
      const session = { id: 'abc123', title: 'Test' };
      const project = { name: 'a', sessions: [session] };
      const h = createProjectsHandler({
        projects: [project],
        selectedProject: project,
        selectedSession: session,
        activeSessions: new Set(),
      });

      h.handleProjectsUpdated({
        projects: [project],
        changedFile: 'C:\\Users\\user\\.claude\\projects\\a\\abc123.jsonl',
      });

      expect(h.getExternalMessageUpdate()).toBe(1);
    });
  });

  // =========================================================================
  // handleLoadingProgress
  // =========================================================================
  describe('handleLoadingProgress', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('should set loading progress data', () => {
      const h = createLoadingProgressHandler();

      h.handleLoadingProgress({ phase: 'scanning', current: 5, total: 10 });

      expect(h.getLoadingProgress()).toEqual({ phase: 'scanning', current: 5, total: 10 });
    });

    it('should clear progress after 500ms delay on phase=complete', () => {
      const h = createLoadingProgressHandler();

      h.handleLoadingProgress({ phase: 'complete' });
      expect(h.getLoadingProgress()).toEqual({ phase: 'complete' });

      vi.advanceTimersByTime(499);
      expect(h.getLoadingProgress()).toEqual({ phase: 'complete' });

      vi.advanceTimersByTime(1);
      expect(h.getLoadingProgress()).toBeNull();

      h.cleanup();
    });

    it('should cancel previous timeout when new progress arrives', () => {
      const h = createLoadingProgressHandler();

      h.handleLoadingProgress({ phase: 'complete' });
      // Before timeout fires, new progress arrives
      h.handleLoadingProgress({ phase: 'scanning', current: 1, total: 5 });

      vi.advanceTimersByTime(1000);
      // Should NOT be null — the complete timeout was cancelled
      expect(h.getLoadingProgress()).toEqual({ phase: 'scanning', current: 1, total: 5 });

      h.cleanup();
    });

    it('should handle rapid complete → scanning → complete transitions', () => {
      const h = createLoadingProgressHandler();

      h.handleLoadingProgress({ phase: 'complete' });
      h.handleLoadingProgress({ phase: 'scanning', current: 0, total: 3 });
      h.handleLoadingProgress({ phase: 'complete' });

      vi.advanceTimersByTime(500);
      expect(h.getLoadingProgress()).toBeNull();

      h.cleanup();
    });

    afterEach(() => {
      vi.useRealTimers();
    });
  });

  // =========================================================================
  // getProjectSessions
  // =========================================================================
  describe('getProjectSessions', () => {
    it('should combine all session types', () => {
      const project: Project = {
        name: 'test',
        sessions: [{ id: 's1' }],
        codexSessions: [{ id: 'c1' }],
        cursorSessions: [{ id: 'r1' }],
      };
      const all = getProjectSessions(project);
      expect(all).toHaveLength(3);
      expect(all.map((s) => s.id)).toEqual(['s1', 'c1', 'r1']);
    });

    it('should handle missing session arrays', () => {
      const project: Project = { name: 'test' };
      const all = getProjectSessions(project);
      expect(all).toHaveLength(0);
    });
  });
});
