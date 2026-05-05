import React, { useState } from 'react';
import { useReviewPrompt } from '../hooks/useReviewPrompt';

export function ReviewPrompt() {
  const { shouldShow, dismiss, openReview } = useReviewPrompt();
  const [hovered, setHovered] = useState(0);

  if (!shouldShow) return null;

  return (
    <div className="review-prompt" role="region" aria-label="Rate this extension">
      <span className="review-prompt__text">Enjoying the extension? Rate us →</span>
      <div
        className="review-prompt__stars"
        onMouseLeave={() => setHovered(0)}
      >
        {[1, 2, 3, 4, 5].map((i) => (
          <button
            key={i}
            type="button"
            className={`review-prompt__star ${i <= hovered ? 'review-prompt__star--lit' : ''}`}
            onMouseEnter={() => setHovered(i)}
            onFocus={() => setHovered(i)}
            onClick={openReview}
            aria-label={`Rate ${i} star${i > 1 ? 's' : ''}`}
          >
            ★
          </button>
        ))}
      </div>
      <button
        type="button"
        className="review-prompt__close"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
