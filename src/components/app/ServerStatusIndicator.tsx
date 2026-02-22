import { useTranslation } from 'react-i18next';
import { useWebSocket } from '../../contexts/WebSocketContext';

export default function ServerStatusIndicator() {
  const { t } = useTranslation('backgroundTasks');
  const { isConnected, serverAlive } = useWebSocket();

  // Determine status: online (green), unstable (yellow), offline (red)
  const status = !isConnected ? 'offline' : !serverAlive ? 'unstable' : 'online';

  const statusConfig = {
    online: {
      color: 'bg-green-500',
      label: t('connection.online'),
    },
    unstable: {
      color: 'bg-yellow-500',
      label: t('connection.unstable'),
    },
    offline: {
      color: 'bg-red-500',
      label: t('connection.offline'),
    },
  };

  const config = statusConfig[status];

  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <div
        className={`w-2 h-2 rounded-full ${config.color} animate-pulse`}
        title={config.label}
      />
      <span className="text-xs text-muted-foreground">{config.label}</span>
    </div>
  );
}
