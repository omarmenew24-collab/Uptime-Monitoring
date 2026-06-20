import MonitorCard from './MonitorCard';

export default function MonitorList({ monitors }) {
  return (
    <div className="flex flex-col gap-3">
      {monitors.map((monitor) => (
        <MonitorCard key={monitor.id} monitor={monitor} />
      ))}
    </div>
  );
}
