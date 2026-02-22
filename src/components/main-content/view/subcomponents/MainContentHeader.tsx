import MobileMenuButton from './MobileMenuButton';
import MainContentTabSwitcher from './MainContentTabSwitcher';
import MainContentTitle from './MainContentTitle';
import BackgroundTasksPopover from '../../../app/BackgroundTasksPopover';
import ServerStatusIndicator from '../../../app/ServerStatusIndicator';
import type { MainContentHeaderProps } from '../../types/types';

export default function MainContentHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  isMobile,
  onMenuClick,
}: MainContentHeaderProps) {
  return (
    <div className="bg-background border-b border-border/60 px-3 py-1.5 sm:px-4 sm:py-2 pwa-header-safe flex-shrink-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          <MainContentTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={shouldShowTasksTab}
          />
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <ServerStatusIndicator />
          <BackgroundTasksPopover currentSessionId={selectedSession?.id} />
          <MainContentTabSwitcher
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            shouldShowTasksTab={shouldShowTasksTab}
          />
        </div>
      </div>
    </div>
  );
}
