import ChatDashboard from './ChatDashboard';

// Force dynamic execution so Next.js does not pre-render this page as static at build time.
// This ensures environment variables are read fresh from the server environment at runtime.
export const dynamic = 'force-dynamic';

export default function Page() {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:5001';
  
  return <ChatDashboard backendUrl={backendUrl} />;
}
