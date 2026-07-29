"use client";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="error-page">
      <div className="error-card">
        <span className="brand-mark" aria-hidden="true">
          R
        </span>
        <h1>Something went sideways.</h1>
        <p>Your original PDF has not been changed.</p>
        <button className="button button-primary" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
