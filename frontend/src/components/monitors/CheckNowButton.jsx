import { useState } from 'react';
import { Zap, Check, X, Clock } from 'lucide-react';
import { useCheckNow } from '@/hooks/useCheckNow';

const resultConfig = {
  up: { icon: Check, text: 'Up', className: 'text-emerald-400 bg-emerald-950/40 border-emerald-800/50' },
  down: { icon: X, text: 'Down', className: 'text-red-400 bg-red-950/40 border-red-800/50' },
  timeout: { icon: Clock, text: 'Timeout', className: 'text-amber-400 bg-amber-950/40 border-amber-800/50' },
};

export default function CheckNowButton({ monitorId }) {
  const { executeCheckNow, isPending } = useCheckNow();
  const [result, setResult] = useState(null);

  const handleClick = () => {
    setResult(null);
    executeCheckNow(monitorId, {
      onSuccess: (data) => {
        setResult(data);
        setTimeout(() => setResult(null), 4000);
      },
    });
  };

  if (result) {
    const config = resultConfig[result.status] || resultConfig.down;
    const Icon = config.icon;
    return (
      <div className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border ${config.className} transition-all`}>
        <Icon size={16} strokeWidth={2} />
        <span>{config.text}</span>
        {result.response_time_ms != null && (
          <span className="font-mono text-xs opacity-70">{result.response_time_ms}ms</span>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-indigo-400 hover:text-indigo-300 hover:bg-indigo-950/30 rounded-md border border-transparent hover:border-indigo-800/50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      title="Run an immediate check"
    >
      <Zap size={16} strokeWidth={1.5} className={isPending ? 'animate-pulse' : ''} />
      {isPending ? 'Checking...' : 'Check Now'}
    </button>
  );
}
