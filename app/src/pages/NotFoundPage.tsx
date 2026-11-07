import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <main className="app-error-page">
      <section className="app-error-panel" aria-labelledby="not-found-title">
        <h1 id="not-found-title">Page not found</h1>
        <p>The address may be outdated, or the page may have moved.</p>
        <Link className="button button-primary" to="/">Return to home</Link>
      </section>
    </main>
  );
}
