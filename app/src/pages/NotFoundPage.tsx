import { Link, useNavigate } from 'react-router-dom';
import { Card, CardContent, Button } from '../components/ui';
import { ShieldCheck } from 'lucide-react';

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <main className="min-h-screen bg-surface cc-flex-col cc-flex items-center justify-center px-6 py-20">
      <Card className="w-full max-w-md">
        <CardContent className="pt-10 pb-12 px-10 text-center">
          <ShieldCheck size={40} className="mx-auto mb-6 cc-text-muted" />
          <h1 id="not-found-title" className="cc-text-2xl cc-font-bold cc-leading-tight cc-text-ink mb-3">
            Page not found
          </h1>
          <p className="cc-text-sm cc-text-muted leading-relaxed mb-8">
            The address may be outdated, or the page may have moved.
          </p>
          <Button variant="primary" onClick={() => navigate('/')} className="w-full md:w-auto">
            Return to home
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
