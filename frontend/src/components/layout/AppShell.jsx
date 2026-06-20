import Sidebar from './Sidebar';
import TopBar from './TopBar';

export default function AppShell({ children }) {
  return (
    <div className="grid grid-cols-[240px_1fr] min-h-dvh">
      <Sidebar />
      <div className="flex flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
