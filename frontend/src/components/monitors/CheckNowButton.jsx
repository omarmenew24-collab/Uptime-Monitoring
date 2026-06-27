import { Zap } from 'lucide-react';
import { useCheckNow } from '@/hooks/useCheckNow';

export default function CheckNowButton({ monitorId }) {
  const { executeCheckNow, isPending } = useCheckNow();

  const handleClick = () => {
    executeCheckNow(monitorId);
  };

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-indigo-400 hover:text-indigo-300 hover:bg-indigo-950/30 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      title="Run an immediate check"
    >
      <Zap size={16} strokeWidth={1.5} />
      {isPending ? 'Checking...' : 'Check Now'}
    </button>
  );
}
